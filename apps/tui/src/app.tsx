/**
 * The Ink root: the whole terminal, laid out.
 *
 * ```
 * ┌ header ── logo · tagline ─────────────────────────── directory ────┐
 * │ conversations│ transcript viewport (bottom-anchored, scrolls)       │
 * │  ▾ folder    │ ⠹ Explore  auth call sites    1m 12s · Grep · 24k   │
 * │    session   │ permission card / picker / agent view, when open    │
 * │  ▸ folder    │ ╭ composer ─────────────────────────────────────╮   │
 * │              │ ╰────────────────────────────────────────────────╯   │
 * │              │ account · model · mode           5hr · Week · Fable │
 * │ Tab          │ status · spinner · tokens · cost                    │
 * └──────────────┴─────────────────────────────────────────────────────┘
 * ```
 *
 * Who has the keys is decided in exactly one place, here. A modal or a
 * permission card, when open, has them; otherwise focus is the composer, the
 * sidebar or the delegated strip, and Tab walks the ring — `nextFocus` in
 * `keymap.ts`, which skips the two stops that come and go: the rail is dropped
 * on a narrow terminal and the strip exists only while something is running.
 * Every child takes an `isActive` prop and touches nothing when it is false, so
 * two components never answer the same keystroke. Esc, Ctrl+C and the scrolling
 * arrows are handled globally only when no modal owns them.
 *
 * The rail can be typed at, which moves three of its keys. A printable
 * character with the focus in the rail is a query, so `a`, `d` and `p` — the
 * archive, delete and pin they used to be — become letters somebody is
 * spelling a title with, and the actions move to Ctrl+A, Ctrl+D and Ctrl+P for
 * as long as a query is on screen. That is the only place in this file where
 * one key means two things depending on state, and it is why the rail's own
 * legend has two forms: the rule is unlearnable unless the screen says it.
 *
 * Two keys are *shared* with the composer rather than taken from it, because
 * Ink has no stop-propagation and both handlers see every press: Esc, which
 * the composer's reverse search owns while it is open, and Tab, which its
 * slash menu and `@` popup own while one of them is. Both are asked about —
 * `isCapturing()`, `hasPopup()` — rather than guessed at. `?` runs the other
 * way: the composer answers it at an empty box, and this file only supplies
 * what it opens, because a `?` acted on here would have been typed into the
 * box on the same keystroke.
 *
 * Shift+Tab steps the permission mode on through the provider's own list —
 * the one `/mode` draws, in its order — and steps over bypass until bypass
 * has been agreed to once. Ctrl+O replaces the layout entirely with the
 * pager, the one view in which nothing is folded. Esc twice at an empty box
 * opens the prompts already sent and goes back to one of them, which is the
 * only move in here that takes rows off the screen.
 *
 * Three of the composer's keys need something only this file has, so they
 * arrive as props and the composer stays a box of text. Ctrl+G hands the whole
 * terminal to `$EDITOR` and takes it back, which is Ink's instance and nobody
 * else's — see `editExternally`. `!` turns the box into a shell prompt and its
 * lines are run by `shell.ts`, landing either as a command row in the
 * transcript or, for `!!`, as a message the agent is asked about. Ctrl+V's
 * images come back through `onSubmit`'s third argument and become attachments
 * beside the `@paths`.
 *
 * Slash commands are parsed before anything is sent. The switchers and
 * viewers are pickers over data the host already knows how to fetch:
 *
 *  - `/profile` — the catalogue, which spawns a probe per account and so is
 *    read here, on demand, never at launch. Unusable accounts stay listed,
 *    greyed, with the reason. Switching is refused mid-run and, when it would
 *    end a conversation, confirmed first.
 *  - `/model`   — the account's own model list, then an effort picker if the
 *    model has levels, then a speed picker if it offers fast mode or ultracode.
 *  - `/mode`    — the provider's permission modes, no more. Bypass is red and
 *    asks twice.
 *  - `/resume`  — the account's stored conversations in this directory. The
 *    sidebar shows every project's, worktrees folded into their repository as
 *    the desktop does, and opens one on Enter — moving the working directory
 *    to wherever it ran.
 *  - `/tasks`   — background work as the provider last listed it, settled rows
 *    included. A delegated agent's row opens what it did; a live row offers to
 *    stop it. What is *running* needs no command: the strip over the composer
 *    draws it while it runs and disappears when the last of it settles — and
 *    Tab reaches it, so Enter opens an agent and `x` stops a task without the
 *    command and the modal it puts over the conversation.
 *  - `/usage`   — every plan window, fetched now; the line under the composer
 *    keeps the 5-hour, the week and Fable's bucket, as the desktop's rings do.
 *  - `/attach`  — a path, read now, sent with the next message.
 *
 * The settings a picker changes are the *next* turn's; the line under the
 * composer shows what the provider actually reported for the current one.
 *
 * The rest of the commands are about what came out of the conversation and
 * what went into the files. Their thinking is in `exportTranscript.ts`,
 * `clipboard.ts` and `changes.ts`; what is here is the wiring and the words:
 *
 *  - `/copy`    — the last reply, or one of its fenced blocks, as source.
 *    "Copied" and "sent to the terminal" are different promises and the flash
 *    keeps them apart: over SSH the bytes go to the emulator by OSC 52, which
 *    no terminal acknowledges.
 *  - `/export`  — the whole conversation as markdown, written through a temp
 *    file and a rename so a half-written export cannot be opened and believed.
 *    Its title is the conversation's own name, which only the rail knows.
 *  - `/diff`    — two questions, one list. `git` answers what is different
 *    from the last commit, whoever changed it; the ledger answers what *this
 *    conversation* did, which is the one that can be answered in a directory
 *    that is not a repository. Either opens into `TextView`.
 *  - `/undo`    — the last file change, taken back, and refused rather than
 *    guessed at whenever the file has moved since.
 *  - `/pin`     — held at the top of its folder, remembered in the
 *    preferences against the session id, which is what a conversation *is*.
 *  - `/title`   — a name, written into the provider's own store through the
 *    same door the automatic namer uses. A provider without that field says so.
 *
 * Last, the window itself. The title, the taskbar light and the bell are the
 * only channel to somebody who has tabbed away — and with several
 * conversations parked and working, that is most of the time. `terminal.ts`
 * owns the bytes, `attention.ts` the reduction, and the effects under "The
 * window, from outside" the policy.
 *
 * Two of those channels point inwards rather than out, and they are under
 * "Who needs you, and what you missed". Ctrl+] goes to the next conversation
 * with a claim on you — stuck on a permission first, then finished since you
 * last had it on screen — and the status line carries the same count, because
 * a rail glyph only works on somebody who thought to look. And a keystroke
 * that ends three minutes of stillness is a return rather than a press, so it
 * brings one longer-lived flash with it saying what changed while nobody was
 * here. Both are `pool.ts` and `attention.ts` deciding; this file times them.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Box, Text, useApp, useInput } from 'ink';

import {
  PERMISSION_MODES,
  isPermissionMode,
  isTaskLive,
  type AgentEvent,
  type Attachment,
  type BackgroundTask,
  type PermissionMode,
  type PlanUsage,
  type ProfileMetadata,
  type ProviderModelOption,
  type ServerProfile,
  type SessionId,
  type SessionSummary,
} from '@rx-artemis/protocol';
import { formatDuration, formatRelative, formatUntil, oneLine } from '@rx-artemis/transcript';
import { isArchived } from '@rx-artemis/protocol';

import { browseRowLabel, browseRows, browseStart, recentDirectories, shortenPath } from './directories.js';
import { needsYou, prunePool, railActivityFor, type Needing } from './pool.js';

import { attachmentFromBytes, readAttachment } from './attachments.js';
import { awayRecap, noticeFor, titleStateOf, type RecapSubject, type RunEnded } from './attention.js';
import { CATALOGUE_KEY, commandsKey, modelsKey, usageKey } from './cache.js';
import { fileLines, gitDiff, type ChangedFile } from './changes.js';
import { checkForUpdate, currentVersion, installRoot } from './update.js';
import { copyText } from './clipboard.js';
import { parseCommand, type Command } from './commands.js';
import { Conversation, type ConversationSettings } from './conversation.js';
import { codeBlocksOf, exportFilename, lastAssistantText, transcriptToMarkdown } from './exportTranscript.js';
import { editInExternalEditor, type ExternalEditResult } from './externalEditor.js';
import { listFiles, type Frecency } from './fileIndex.js';
import type { HistoryScope } from './history.js';
import type { Launched } from './launch.js';
import type { ModelListing } from './host.js';
import { renderDiff } from './render/diff.js';
import { runShell } from './shell.js';
import { AttentionTimer, notify, progressState, setTitle, titleFor } from './terminal.js';
import { useTerminalSize } from './hooks/useTerminalSize.js';
import { ACCENT } from './theme.js';
import { nextFocus, type Focus } from './keymap.js';
import { Composer, type ComposerHandle, type FileIndex, type PastedImage } from './components/Composer.js';
import { DelegatedStrip, delegatedRows, type DelegatedRow } from './components/Delegated.js';
import { Header } from './components/Header.js';
import { Help, helpLines } from './components/Help.js';
import { Pager } from './components/Pager.js';
import { PermissionCard } from './components/PermissionCard.js';
import { Picker, isTypable, type PickerAction, type PickerItem } from './components/Picker.js';
import { Prompt } from './components/Prompt.js';
import { QueuedStrip } from './components/QueuedStrip.js';
import { SessionPreview } from './components/SessionPreview.js';
import { Sidebar, railRows, type RailRow } from './components/Sidebar.js';
import { TodoStrip } from './components/TodoStrip.js';
import { basename, isAbsolute, resolve as resolvePath } from 'node:path';
import { homedir } from 'node:os';
import { readdir, rename, stat, writeFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { describeWorkspace } from '@rx-artemis/core';
import { StatusBar } from './components/StatusBar.js';
import { TextView } from './components/TextView.js';
import { ReplayRows, TranscriptViewport } from './components/Transcript.js';

export interface AppProps {
  readonly launched: Launched;
  /**
   * Which files `@` offers first: what was picked before, and how long ago.
   * Read and written here, loaded and saved by `main.tsx`, and absent from
   * `--print`, which completes nothing.
   */
  readonly files?: Frecency;
}

interface PickerModal {
  readonly kind: 'picker';
  readonly title: string;
  readonly items: readonly PickerItem[];
  readonly initialKey?: string;
  readonly hint?: string;
  readonly onSelect: (item: PickerItem) => void;
  /**
   * What Esc does besides taking the picker down, for a list that changed
   * something on the way in. Without it Esc simply closes.
   */
  readonly onCancel?: () => void;
  /**
   * Which opening this is. A picker that opened on a cached answer is
   * refreshed in place when the fresh one lands — but only if it is still
   * the picker on screen, which the token is how the refresh can tell.
   */
  readonly token?: number;
  /*
   * What a list can do *to* a row without leaving it. All four are the
   * picker's own keys — see `components/Picker.tsx` — and are carried here
   * rather than answered here, because a modal is a description of a list and
   * this file is the one place that knows what archiving a conversation means.
   * A picker that passes none of them advertises none of them.
   */
  /** Let the list be typed at. Costs it `j` and `k`, which become letters. */
  readonly filterable?: boolean;
  /** Space. */
  readonly onPreview?: (item: PickerItem) => void;
  /** Ctrl+R. */
  readonly onRename?: (item: PickerItem) => void;
  /** Ctrl+A, Ctrl+P, and whatever else a caller wants a chord for. */
  readonly onSecondary?: readonly PickerAction[];
}

/**
 * One line, asked for: what Ctrl+R opens over the conversation list.
 *
 * A modal rather than the composer, because the composer is holding a message
 * somebody is part-way through writing and a name is not that message. See
 * `components/Prompt.tsx`, which is the box; what is here is what the answer
 * is for.
 */
interface PromptModal {
  readonly kind: 'prompt';
  readonly title: string;
  readonly initial: string;
  /** The line as it was typed, the empty one included. */
  readonly onSubmit: (text: string) => void;
  /** Esc. Never carries a value, because nothing was agreed to. */
  readonly onCancel: () => void;
}

interface LoadingModal {
  readonly kind: 'loading';
  readonly title: string;
}

interface ReplayModal {
  readonly kind: 'replay';
  readonly title: string;
  readonly events: readonly AgentEvent[];
}

/**
 * The whole conversation, unfolded.
 *
 * It carries nothing: the pager reads the same transcript this file is already
 * holding. Mounted *instead of* the layout rather than inside it, because it
 * draws the terminal — see `components/Pager.tsx` — and because everything
 * behind a full-screen reader should be unmounted rather than merely quiet.
 */
interface PagerModal {
  readonly kind: 'pager';
}

/** The key map, drawn over the conversation. `keymap.ts` is what it says. */
interface HelpModal {
  readonly kind: 'help';
}

/**
 * A wall of text with a way through it: what `/diff` opens into.
 *
 * The lines are built once, at the width the pane had when the command ran,
 * because `renderDiff` cuts to a width and the alternative is re-rendering
 * every diff on every resize for a view somebody is reading rather than
 * living in. A resize while it is open therefore truncates rather than
 * reflows, and closing and reopening is exact again.
 */
interface TextModal {
  readonly kind: 'text';
  readonly title: string;
  readonly lines: readonly string[];
}

type Modal = PickerModal | PromptModal | LoadingModal | ReplayModal | PagerModal | HelpModal | TextModal;

/** The row that leaves the recents list for the filesystem. Not a path, so it cannot be one. */
const BROWSE_KEY = '\u0000browse';

/**
 * `/diff`'s first row: git's answer rather than one of the ledger's files.
 * A leading NUL for the same reason `BROWSE_KEY` has one — the rows beside it
 * are indices, and this must not be able to collide with one.
 */
const WORKING_TREE_KEY = '\u0000working-tree';

const MODE_LABEL: Readonly<Record<PermissionMode, string>> = {
  default: 'Ask',
  acceptEdits: 'Accept edits',
  plan: 'Plan',
  auto: 'Auto',
  dontAsk: "Don't ask",
  bypassPermissions: 'Bypass permissions',
};

const MODE_DETAIL: Readonly<Record<PermissionMode, string>> = {
  default: 'prompt for anything not already allowed',
  acceptEdits: 'file edits go through; everything else asks',
  plan: 'research and propose only; no changes',
  auto: 'the provider decides; asks when it judges the risk real',
  dontAsk: 'never prompt — denies instead of asking',
  bypassPermissions: 'approve everything. Dangerous.',
};

const QUIT_WINDOW_MS = 2_000;
/**
 * How long the first Esc waits for the second.
 *
 * Long enough for two deliberate presses and short enough that an Esc pressed
 * to stop something, and another half a second later to make sure, is not read
 * as a request to go back through the conversation.
 */
const ESC_ESC_WINDOW_MS = 600;
/** A plan-usage read is a CLI call; one a minute is the desktop's own tolerance. */
const PLAN_USAGE_MIN_INTERVAL_MS = 60_000;
/** A cached plan reading older than this is not shown while the fresh one is read: the windows will have moved. */
const USAGE_SEED_MAX_AGE_MS = 24 * 60 * 60_000;
/** A model list older than this is re-read at launch, in the background, so `/model` has a fresh one. */
const MODELS_WARM_MAX_AGE_MS = 24 * 60 * 60_000;
/** The key legend, for a picker whose hint has something else to say first. */
const PICKER_KEYS = '↑↓ · Enter · Esc';
/**
 * Rows a list keeps while a preview is open beneath it.
 *
 * The two share the slot between the transcript and the composer, and what
 * falls off the bottom of an Ink column is whatever is last in it — which here
 * is the composer and the line under it. So the list is what gives way: it is
 * the thing that already scrolls, and the preview is the thing that was just
 * asked for. Eight rather than the picker's own twelve, which is still most of
 * a directory's conversations.
 */
const PICKER_ROWS_WITH_PREVIEW = 8;
/**
 * What the preview and the furniture round it need out of the pane: ten lines
 * for the box, five for the list's title, query and legend, and six for the
 * composer, the status line and the strips above them.
 */
const PREVIEW_SLOT_ROWS = 21;
/**
 * Below this many columns the rail is dropped; the pickers cover the same
 * ground. The conversation needs about ninety columns to read as prose, and
 * the rail takes thirty-two.
 */
const SIDEBAR_MIN_COLUMNS = 120;
const SIDEBAR_WIDTH = 32;
/** Below this many rows the two-line logo becomes one word. */
const TALL_HEADER_MIN_ROWS = 24;
/** Lines one arrow press scrolls — a wheel tick arrives as a few of these. */
const SCROLL_STEP = 2;
/**
 * The run a `!` command's transcript row belongs to: none of them.
 *
 * `apply` counts sequence numbers per run to notice events dropped in transit.
 * A row written here has nothing to do with the provider's stream, so it gets a
 * run of its own and never disturbs that count.
 */
const SHELL_RUN_ID = 'local-shell';

/**
 * The same trick for the commands this file answers itself.
 *
 * `/export` and `/undo` leave a row behind — what was written, what was put
 * back — and neither came off the provider's stream either. A run id apart
 * from the shell's, because the two are different sources and a `$` row and a
 * `/` row sharing a numbering would be one accident away from being sorted
 * together.
 */
const LOCAL_RUN_ID = 'local-command';

/**
 * The columns a {@link TextModal}'s lines are built to: the pane, less its own
 * padding, the reader's border and the reader's padding.
 */
const TEXT_VIEW_CHROME = 6;

/** How long the taskbar light stays red after a failed turn before it goes out. */
const PROGRESS_ERROR_MS = 5_000;

/**
 * How long the keyboard has to be still before coming back to it is a return.
 *
 * Three minutes is well past a pause for thought and well short of a lunch, so
 * the line it triggers lands on somebody who has genuinely lost the thread
 * rather than on somebody who stopped to read the screen. It is longer than
 * either bell's delay on purpose: a notification is worth sending at six
 * seconds because it goes somewhere else, and a line in the terminal is only
 * worth drawing once you have stopped watching the terminal.
 */
const AWAY_MS = 3 * 60_000;

/**
 * How long the welcome-back line holds the status bar.
 *
 * Four times an ordinary flash. The usual one answers a key that was just
 * pressed and the eye is already on the place it appears; this one is news
 * about something else, arriving on a keystroke that was aimed at something
 * else, and it has a sentence to be read rather than two words to be
 * recognised.
 */
const RECAP_FLASH_MS = 8_000;

/**
 * Ctrl+] as the two kinds of terminal report it.
 *
 * One that speaks the kitty keyboard protocol sends the bracket with a Ctrl
 * flag on it. Every other terminal sends the C0 byte the chord has meant since
 * ASCII, and Ink — which folds Ctrl+A..Z back into letters and nothing else —
 * hands that over as a one-character string with no modifier set at all. Both
 * are the same press, and a key map that only knew one of them would work on
 * about half the terminals people use.
 */
const NEXT_NEEDY_BYTE = '\u001d';
const isNextNeedy = (input: string, key: { readonly ctrl: boolean }): boolean =>
  input === NEXT_NEEDY_BYTE || (key.ctrl && input === ']');

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** `3 lines`, for a row of `/copy`'s list. */
const countOfLines = (text: string): string => {
  const lines = text.split('\n').length;
  return `${String(lines)} line${lines === 1 ? '' : 's'}`;
};

export function App({ launched, files }: AppProps): React.JSX.Element {
  const { host, descriptors, cache, preferences, history } = launched;
  const { exit, suspendTerminal } = useApp();
  const { columns, rows } = useTerminalSize();
  /*
   * How wide the conversation's own pane is: the terminal, less the rail when
   * there is one. Worked out here rather than down in the layout because
   * three things that are not layout need it — the rows `/help` prints, and
   * the width the transcript and a replayed agent decide a diff gutter on.
   */
  const showSidebar = columns >= SIDEBAR_MIN_COLUMNS;
  const mainWidth = showSidebar ? columns - SIDEBAR_WIDTH : columns;

  /**
   * A conversation, ready to be shown.
   *
   * Everything it can already answer from the last launch is put in before it
   * is drawn once: the plan reading under the composer, and the provider's
   * commands, which `/` is often the first thing typed at. See `cache.ts`.
   */
  const makeConversation = useCallback(
    (settings: ConversationSettings): Conversation => {
      const created = new Conversation({
        driver: host.runs,
        settings,
        capabilitiesFor: (id) => host.capabilitiesFor(id),
      });
      const remembered = cache.get<PlanUsage>(usageKey(settings.profileId));
      if (remembered !== undefined && Date.now() - remembered.at < USAGE_SEED_MAX_AGE_MS) created.setPlanUsage(remembered.value);
      const commands = cache.get<readonly string[]>(commandsKey(settings.profileId, settings.cwd));
      if (commands !== undefined) created.seedSlashCommands(commands.value);
      return created;
    },
    [host, cache],
  );

  /*
   * More than one conversation is alive at a time, and only one is on screen.
   * ------------------------------------------------------------------------
   *
   * Switching used to be refused while a turn was running, which made the one
   * thing worth doing during a long turn — going and reading something else —
   * the one thing you could not do. The registry never needed that: a run has
   * one producer and any number of consumers, and "consumers come and go; the
   * run does not care" (`sessions/registry.ts`). What tied a turn to the
   * screen was this file holding exactly one `Conversation`.
   *
   * So it holds several. Each one subscribes to the registry and keeps only
   * its own run's events, so a parked conversation goes on filling its own
   * transcript — including a permission request, which is why the rail shows
   * that too. Switching back is instant and complete, because nothing was
   * torn down and nothing has to be re-read.
   *
   * The pool is bounded by disposing, on every switch, whatever is neither on
   * screen nor working. What that throws away is a transcript the store
   * already has, so the cost of being wrong is one read.
   */
  const [pool, setPool] = useState<readonly Conversation[]>(() => [makeConversation(launched.settings)]);
  const [conversation, setConversation] = useState<Conversation>(() => pool[0] as Conversation);
  /*
   * Mirrors of the two states above, for callbacks that must read the
   * *current* value without being rebuilt every time it changes — and for the
   * unmount, which runs long after the closure that scheduled it was made.
   */
  const conversationRef = useRef(conversation);
  conversationRef.current = conversation;
  const poolRef = useRef(pool);
  poolRef.current = pool;

  /*
   * What this file remembers about each pooled conversation.
   *
   * Three facts a `Conversation` has no reason to keep and this file cannot
   * work out twice: when it was last on the screen, how its last turn ended,
   * and when it stopped to ask. They are what Ctrl+] and the welcome-back
   * line are built from — see "Who needs you, and what you missed".
   *
   * Refs, because none of them changes what is on the frame they are written
   * in: every one is written from a subscription the conversation's own store
   * is already going to re-render for, and a `useState` here would be a
   * second render for a number nothing drew yet.
   *
   * Keyed by a name minted here rather than by the session id. A conversation
   * nothing has been sent in has no session and can still be the one that
   * needs you; and a session id arrives some seconds after the object does, so
   * a key that appears late is a key that loses whatever was written under the
   * old one. The `WeakMap` is what makes the name stable for as long as the
   * object is and no longer.
   */
  const conversationKeys = useRef(new WeakMap<Conversation, string>());
  const keysMinted = useRef(0);
  const keyFor = useCallback((alive: Conversation): string => {
    const known = conversationKeys.current.get(alive);
    if (known !== undefined) return known;
    const minted = `c${String(keysMinted.current++)}`;
    conversationKeys.current.set(alive, minted);
    return minted;
  }, []);

  /**
   * When each conversation was last looked at.
   *
   * Written as one leaves the screen, because that is the last moment it was
   * being looked at. The one *on* the screen is a special case handled where
   * the map is read rather than written: it is being looked at now, whatever
   * was last recorded, and a turn that finished in front of somebody must not
   * queue itself up as something they have not seen.
   */
  const seenAt = useRef(new Map<string, number>());
  /** How each conversation's last turn ended, for the welcome-back line. */
  const runEnds = useRef(new Map<string, RunEnded>());
  /** When each stopped to ask. Stale, harmlessly, once the question is answered. */
  const askedAt = useRef(new Map<string, number>());

  useEffect(
    () => () => {
      for (const alive of poolRef.current) alive.dispose();
    },
    [],
  );

  const switchTo = useCallback(
    (next: Conversation) => {
      if (next === conversationRef.current) return;
      // The moment it stopped being looked at, which is what "finished since
      // you last looked at it" is measured against.
      seenAt.current.set(keyFor(conversationRef.current), Date.now());
      // Decided by `prunePool`, disposed here: the rule is pure and tested, and
      // a state updater with side effects is a thing React may run twice.
      const { kept, dropped } = prunePool(poolRef.current, next, (parked) => parked.isLive);
      for (const gone of dropped) gone.dispose();
      poolRef.current = kept;
      setPool(kept);
      conversationRef.current = next;
      setConversation(next);
      setScroll(0);
    },
    [keyFor],
  );

  const state = useSyncExternalStore(conversation.subscribe, conversation.getState);

  /*
   * A parked conversation has no other way to reach the screen: nothing here
   * re-renders when *its* run moves, so the rail would show it working for as
   * long as it took to touch a key. One listener each, and the rail is honest.
   */
  const [parkedTick, setParkedTick] = useState(0);
  const parkedWentIdle = useRef(false);
  useEffect(() => {
    const offs = pool
      .filter((parked) => parked !== conversation)
      .map((parked) => {
        let was = parked.getState().status;
        return parked.subscribe(() => {
          const now = parked.getState().status;
          // A parked turn finishing is the one change the rail's *list* has
          // to hear about — its title and time have moved in the store — and
          // the active conversation's own idle transitions are already
          // watched. Flagged here, acted on below, so the effect that owns
          // `refreshRail` does not have to be rebuilt per parked conversation.
          if (was !== 'idle' && now === 'idle') parkedWentIdle.current = true;
          was = now;
          setParkedTick((n) => n + 1);
        });
      });
    return () => {
      for (const off of offs) off();
    };
  }, [pool, conversation]);

  /** What each conversation is doing, for the glyph in front of its title. */
  const railActivity = useMemo(
    () => railActivityFor(pool.map((parked) => parked.getState())),
    // `parkedTick` is the signal that a parked conversation moved; `state`,
    // that the one on screen did.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pool, parkedTick, state],
  );
  const { transcript } = conversation;

  const [modal, setModal] = useState<Modal | null>(null);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [flash, setFlash] = useState<string | undefined>(undefined);
  const [update, setUpdate] = useState<string | undefined>(undefined);
  const [focus, setFocus] = useState<Focus>('composer');
  const [scroll, setScroll] = useState(0);
  /** The agent's checklist, opened into its rows with Ctrl+T; one line otherwise. */
  const [todoExpanded, setTodoExpanded] = useState(false);
  /** How far back the viewport can go, as it last measured itself. */
  const scrollExtent = useRef({ maxOffset: 0, viewportLines: 0 });
  const onScrollExtent = useCallback((extent: { readonly maxOffset: number; readonly viewportLines: number }) => {
    scrollExtent.current = extent;
  }, []);
  const scrollBy = useCallback((lines: number) => {
    // Past the top is allowed by one screen: the viewport draws more rows as
    // the offset nears the top of what it has, and clamps what it shows.
    setScroll((current) => Math.max(0, Math.min(current + lines, scrollExtent.current.maxOffset + scrollExtent.current.viewportLines)));
  }, []);
  const [pendingAttachments, setPendingAttachments] = useState<readonly { name: string; attachment: Attachment }[]>([]);
  const quitArmed = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The first Esc of a possible Esc, Esc; see {@link ESC_ESC_WINDOW_MS}. */
  const escArmed = useRef<ReturnType<typeof setTimeout> | null>(null);
  const planFetchedAt = useRef(0);
  const pickerToken = useRef(0);
  /**
   * Whether bypass has been agreed to, once, in this session.
   *
   * Shift+Tab steps over `bypassPermissions` until it has: a key that can be
   * hit by accident must not be able to turn every prompt off, and the
   * picker's two-step is where that decision belongs. Once it has been taken
   * the cycle includes bypass — leaving it out for the rest of the session
   * would mean the one mode you have to go to the picker to *leave* by
   * keyboard, which is a worse trap than the one being avoided.
   */
  const bypassConfirmed = useRef(false);

  const pendingRequest = state.pendingPermissions[0];
  const workspace = basename(state.settings.cwd) || state.settings.cwd;
  const live = state.status !== 'idle';
  const locked = live && !state.capabilities.midRunSteering;

  const say = useCallback(
    (level: 'info' | 'warn' | 'error', text: string, detail?: string) => {
      transcript.note(level, text, detail);
    },
    [transcript],
  );

  /**
   * Which flash is on the line, so an older one's timer cannot take a newer
   * one off. Two of them now have very different lives — the welcome-back
   * line lasts four times as long as "pinned" — and without this the short one
   * pressed a moment later would clear the long one when *its* two seconds
   * were up, which reads as a message that flickered rather than one that was
   * replaced.
   */
  const flashToken = useRef(0);
  const showFlash = useCallback((text: string, ms = QUIT_WINDOW_MS) => {
    const mine = ++flashToken.current;
    setFlash(text);
    setTimeout(() => {
      if (flashToken.current === mine) setFlash(undefined);
    }, ms).unref?.();
  }, []);

  // A new row arriving while scrolled back is the one moment "follow" would
  // hide something; anything else that changes the transcript keeps the
  // person where they were.
  useEffect(() => {
    if (live) setScroll(0);
  }, [live]);

  /* ---------------------------------------------------------------------- */
  /* The rail's data                                                         */
  /* ---------------------------------------------------------------------- */

  const [sessions, setSessions] = useState<readonly SessionSummary[]>([]);
  const [accounts, setAccounts] = useState<readonly ProfileMetadata[]>([]);
  const [railLoading, setRailLoading] = useState(true);
  const [railIndex, setRailIndex] = useState(0);
  /**
   * What is being typed at the rail; empty when nothing is.
   *
   * One string rather than a mode flag and a string, because a rail of two
   * hundred conversations is searched rather than walked and there is nothing
   * to enter or leave: any printable key with the focus in the rail starts a
   * query, and Esc ends one. `/` is the exception only in that it does not type
   * itself, so `/foo` and `foo` reach the same place.
   */
  const [railQuery, setRailQuery] = useState('');
  /**
   * The query, and the cursor put back on the first row of what it found.
   *
   * The two go together every single time — a cursor left at row forty of a
   * list that has just become three rows long is a selection nobody can see —
   * so they are one function rather than two calls somebody has to remember to
   * make in the same breath.
   */
  const setRailFilter = useCallback((next: string | ((current: string) => string)) => {
    setRailQuery(next);
    setRailIndex(0);
  }, []);
  /**
   * The conversation Space is showing, unopened.
   *
   * Drawn in the same slot the pickers use — under the picker, when one is
   * open — rather than inside the rail, and for the rail's own reason: the rail
   * is thirty-two columns wide and a preview is a title, a branch, a model, a
   * folder and four lines of the opening prompt. Cut to thirty columns none of
   * that is worth reading, and a box that grew the rail to fit it would push
   * the conversation sideways every time the cursor passed a row. The slot over
   * the composer has the width, and it means Space shows the same box wherever
   * it is pressed. See `components/SessionPreview.tsx`.
   */
  const [preview, setPreview] = useState<SessionSummary | null>(null);
  // Folders unfolded in the rail, keyed by project root. The current one is
  // always open.
  const [openFolders, setOpenFolders] = useState<ReadonlySet<string>>(() => new Set());
  // Folders showing every conversation rather than the newest few.
  const [expandedFolders, setExpandedFolders] = useState<ReadonlySet<string>>(() => new Set());
  /**
   * Directory → project root. A worktree maps to its main checkout, which is
   * what folds worktrees into one folder; an unresolved directory is its own
   * project until the answer lands.
   *
   * Resolved *before* a session list is shown, never after: a row that first
   * paints under a directory-named folder and then jumps into its repository's
   * reads as the rail reordering itself. The ref is the source of truth so a
   * refresh can consult it without waiting for a render; the state is what the
   * rail re-renders on.
   */
  const [projectRoots, setProjectRoots] = useState<Readonly<Record<string, string>>>({});
  const projectRootsRef = useRef<Readonly<Record<string, string>>>({});
  const projectOf = useCallback((cwd: string) => projectRoots[cwd] ?? cwd, [projectRoots]);
  const resolveProjectRoots = useCallback(async (cwds: readonly string[]) => {
    const unresolved = [...new Set(cwds)].filter((cwd) => projectRootsRef.current[cwd] === undefined);
    if (unresolved.length === 0) return;
    const pairs = await Promise.all(
      unresolved.map(async (cwd) => {
        try {
          const description = await describeWorkspace(cwd);
          return [cwd, description.projectRoot ?? description.repoRoot ?? cwd] as const;
        } catch {
          return [cwd, cwd] as const;
        }
      }),
    );
    projectRootsRef.current = { ...projectRootsRef.current, ...Object.fromEntries(pairs) };
    setProjectRoots(projectRootsRef.current);
  }, []);

  const refreshRail = useCallback(async () => {
    try {
      const metadata = (await host.profiles.listMetadata()).filter((profile) => profile.disabled !== true);
      setAccounts(metadata);
      const list = await host.listSessionsAcross(metadata.map((profile) => ({ id: profile.id, providerId: profile.providerId })));
      await resolveProjectRoots(list.map((session) => session.cwd));
      setSessions(list);
    } catch {
      // The rail is a convenience over the pickers; a failed read leaves it as it was.
    } finally {
      setRailLoading(false);
    }
  }, [host, resolveProjectRoots]);

  useEffect(() => {
    void refreshRail();
  }, [refreshRail]);
  useEffect(() => {
    if (state.status === 'idle' && state.sessionId !== undefined) void refreshRail();
  }, [state.status, state.sessionId, refreshRail]);
  useEffect(() => {
    if (!parkedWentIdle.current) return;
    parkedWentIdle.current = false;
    void refreshRail();
  }, [parkedTick, refreshRail]);
  /*
   * Whatever the settings line says is what the next launch opens as.
   *
   * Watched here rather than written at each picker, because there are five
   * ways to change these — three pickers, a flag on a slash command, and
   * opening someone else's conversation from the rail — and a save at each is
   * five chances to forget one. The model is stored against the account it
   * belongs to; see `preferences.ts`.
   */
  useEffect(() => {
    const { profileId, permissionMode, model, modelLabel, effort, fastMode, ultracode } = state.settings;
    preferences.save({ profileId, permissionMode });
    preferences.saveModelFor(profileId, {
      ...(model === undefined ? {} : { model }),
      ...(modelLabel === undefined ? {} : { modelLabel }),
      ...(effort === undefined ? {} : { effort }),
      ...(fastMode === undefined ? {} : { fastMode }),
      ...(ultracode === undefined ? {} : { ultracode }),
    });
  }, [
    preferences,
    state.settings.profileId,
    state.settings.permissionMode,
    state.settings.model,
    state.settings.modelLabel,
    state.settings.effort,
    state.settings.fastMode,
    state.settings.ultracode,
  ]);

  // The working directory can change without the list doing so (`/cwd`).
  useEffect(() => {
    void resolveProjectRoots([state.settings.cwd]);
  }, [state.settings.cwd, resolveProjectRoots]);

  const currentProject = projectOf(state.settings.cwd);
  useEffect(() => {
    setOpenFolders((current) => (current.has(currentProject) ? current : new Set([...current, currentProject])));
  }, [currentProject]);

  const accountOf = useCallback(
    (session: SessionSummary): string | undefined =>
      session.profileId === state.settings.profileId
        ? undefined
        : accounts.find((profile) => profile.id === session.profileId)?.label ?? 'another account',
    [accounts, state.settings.profileId],
  );
  /**
   * The conversations held at the top of their folder.
   *
   * The store memoises the set on the identity of the array it was built from,
   * so `pinnedSet()` is free to call on every draw — but that also means
   * nothing here re-renders when a pin is toggled, since the call site never
   * changes. `pinTick` is the nudge: `/pin` bumps it, this re-derives, and the
   * rail and the sidebar both see the new set. See `preferences.ts`.
   */
  const [pinTick, setPinTick] = useState(0);
  const pinned = useMemo(
    () => preferences.pinnedSet(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [preferences, pinTick],
  );
  const rail: readonly RailRow[] = useMemo(
    () => railRows(sessions, openFolders, projectOf, accountOf, expandedFolders, { pinned, query: railQuery }),
    [sessions, openFolders, projectOf, accountOf, expandedFolders, pinned, railQuery],
  );

  /**
   * Pin a conversation, or unpin it, whichever it is.
   *
   * The whole of `/pin`'s doing, taken apart from `/pin`'s knowing *which*: the
   * rail's `p` and the conversation list's Ctrl+P both name a row that is not
   * the conversation on screen, and a second copy of "write it down, re-derive,
   * say which way it went" is a second chance for the three to drift.
   */
  const togglePinFor = useCallback(
    (sessionId: string) => {
      const nowPinned = preferences.togglePin(sessionId);
      setPinTick((tick) => tick + 1);
      showFlash(nowPinned ? 'pinned' : 'unpinned');
    },
    [preferences, showFlash],
  );

  /**
   * Put a conversation away, or take it back out.
   *
   * A tag written into the provider's own store — the same one the desktop
   * writes — so a row archived here is archived there. Nothing is destroyed
   * and the conversation is still resumable from the archive folder, which is
   * what makes this the safe half of the pair and why it asks nothing before
   * doing it.
   *
   * Up here, above the pickers, because it is no longer the rail's alone: the
   * conversation list offers the same thing on Ctrl+A, and a list that archived
   * by a different route than the rail's would be two answers to one question.
   */
  const archiveRailSession = useCallback(
    async (session: SessionSummary) => {
      const archived = isArchived(session);
      if (host.capabilitiesFor(session.providerId)?.tagSession !== true) {
        setNotice(`${state.settings.providerLabel} cannot archive a conversation.`);
        return;
      }
      try {
        const done = await host.archiveSession(session.profileId, session.providerId, session.id, session.cwd, !archived);
        if (!done) {
          setNotice('That conversation could not be archived; it may already be gone.');
          return;
        }
        say('info', `${archived ? 'Restored' : 'Archived'} ${oneLine(session.title, 60)}.`);
        await refreshRail();
      } catch (error) {
        say('error', `Could not archive that conversation: ${describeError(error)}`);
      }
    },
    [host, state.settings.providerLabel, say, refreshRail],
  );

  /**
   * Name a stored conversation, whichever one it is.
   *
   * Written into the provider's own store, through the same door the automatic
   * namer uses and the desktop's rename menu item uses: a typed title and a
   * generated one are the same fact about a session, and a second store kept
   * here would be a fact about one installation — invisible to the desktop,
   * absent on another machine. A provider whose store has no such field says
   * so and nothing is written; see `Capabilities.renameSession`.
   *
   * It takes an id rather than reading the conversation on screen, because
   * `/title` is no longer the only way in: Ctrl+R over a row of the
   * conversation list names *that* row, which is very often not this one.
   */
  const renameStoredSession = useCallback(
    async (sessionId: SessionId, name: string): Promise<void> => {
      if (name.length === 0) {
        showFlash('a name cannot be empty');
        return;
      }
      if (host.capabilitiesFor(state.settings.providerId)?.renameSession !== true) {
        showFlash('this provider does not let a conversation be renamed');
        return;
      }
      try {
        const done = await host.renameSession(
          state.settings.profileId,
          state.settings.providerId,
          sessionId,
          state.settings.cwd,
          name,
        );
        if (!done) {
          showFlash('this provider does not let a conversation be renamed');
          return;
        }
        showFlash(`named ${oneLine(name, 48)}`);
        // The rail is where the name is read back from, and it is what
        // `/export` takes its title and its filename from.
        await refreshRail();
      } catch (error) {
        say('error', `Could not rename this conversation: ${describeError(error)}`);
      }
    },
    [host, state.settings.profileId, state.settings.providerId, state.settings.cwd, showFlash, say, refreshRail],
  );

  /* ---------------------------------------------------------------------- */
  /* Plan usage                                                              */
  /* ---------------------------------------------------------------------- */

  const refreshPlanUsage = useCallback(
    async (force = false): Promise<void> => {
      if (!force && Date.now() - planFetchedAt.current < PLAN_USAGE_MIN_INTERVAL_MS) return;
      planFetchedAt.current = Date.now();
      try {
        const usage = await host.fetchPlanUsage(state.settings.profileId, state.settings.providerId);
        conversation.setPlanUsage(usage);
        // Only a real reading is worth remembering; "could not read" is not.
        if (usage !== null && usage.available) cache.set(usageKey(state.settings.profileId), usage);
      } catch {
        // A gauge that cannot be read is a gauge that is not shown.
      }
    },
    [host, cache, state.settings.profileId, state.settings.providerId, conversation],
  );

  /** What the line under the composer shows for an account before its fresh reading lands. */
  const seedPlanUsage = useCallback(
    (profileId: string) => {
      const remembered = cache.get<PlanUsage>(usageKey(profileId));
      conversation.setPlanUsage(
        remembered !== undefined && Date.now() - remembered.at < USAGE_SEED_MAX_AGE_MS ? remembered.value : null,
      );
    },
    [cache, conversation],
  );

  /**
   * The provider's own slash commands — the user's skills among them — read
   * now and remembered, so the next launch in this directory has them before
   * the first frame rather than a second after it.
   */
  const refreshCommands = useCallback(async (): Promise<void> => {
    const { profileId, providerId, cwd } = state.settings;
    try {
      const commands = await host.listCommands(profileId, providerId, cwd);
      if (commands.length === 0) return;
      cache.set(commandsKey(profileId, cwd), commands);
      conversation.seedSlashCommands(commands);
    } catch {
      // The menu keeps whatever it had; a run will report the rest.
    }
  }, [host, cache, conversation, state.settings]);

  /*
   * Asked again when the account or the directory changes, because both
   * change the answer: commands are discovered relative to a working
   * directory, and an account's plugins are its own. The cached list for
   * wherever we have arrived goes up first, as at launch.
   */
  useEffect(() => {
    const { profileId, cwd } = state.settings;
    const remembered = cache.get<readonly string[]>(commandsKey(profileId, cwd));
    if (remembered !== undefined) conversation.seedSlashCommands(remembered.value);
    const timer = setTimeout(() => void refreshCommands(), 1_500);
    return () => clearTimeout(timer);
  }, [cache, conversation, refreshCommands, state.settings.profileId, state.settings.cwd]);

  /** The account's model list, read now and remembered for the next `/model` and the next launch. */
  const readModels = useCallback(async (): Promise<ModelListing> => {
    const listing = await host.listModels(state.settings.profileId, state.settings.providerId);
    if (listing.live) cache.set(modelsKey(state.settings.profileId), listing);
    return listing;
  }, [host, cache, state.settings.profileId, state.settings.providerId]);

  /*
   * What the screen needs but did not wait for, a beat after the first frame
   * so the probes do not race it: the plan windows, and — when the remembered
   * model list is a day old or missing — a fresh one, so that `/model` costs
   * nothing later. The commands have an effect of their own above, because
   * they have to be re-asked when the directory changes.
   *
   * Concurrently, because they are independent CLI calls and running them in
   * a line made the last of them seconds late.
   */
  useEffect(() => {
    const timer = setTimeout(() => {
      const known = cache.get(modelsKey(state.settings.profileId));
      void Promise.all([
        refreshPlanUsage(true),
        known === undefined || Date.now() - known.at > MODELS_WARM_MAX_AGE_MS
          ? // The picker will ask again when it is opened.
            readModels().catch(() => undefined)
          : undefined,
      ]).then(
        async () => {
          // An installed copy learns, once a day, whether a newer release
          // exists; a checkout does not need telling. See `update.ts`.
          if (installRoot() === undefined) return;
          const newer = await checkForUpdate(currentVersion(), cache);
          if (newer !== null) setUpdate(newer);
        },
        () => undefined,
      );
    }, 1_500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (state.status === 'idle' && state.sessionId !== undefined) void refreshPlanUsage();
  }, [state.status, state.sessionId, refreshPlanUsage]);

  /* ---------------------------------------------------------------------- */
  /* Resume                                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * Show a stored conversation, reading it in if it is not already alive.
   *
   * Three cases, in order: it is the one on screen, and nothing happens; it is
   * one of the parked ones, and switching is instant because its transcript
   * and its run were never let go of; or it is neither, and it is read from
   * the store into a conversation of its own.
   *
   * `into` is the account and directory it belongs to, for a conversation
   * from elsewhere in the rail. Without it the current ones are used, which is
   * what `/resume` and `--resume` want — they only ever name a conversation
   * from here.
   */
  const loadSession = useCallback(
    async (sessionId: SessionId, title: string, into?: ConversationSettings): Promise<void> => {
      const current = conversationRef.current;
      if (current.getState().sessionId === sessionId) return;
      const parked = pool.find((candidate) => candidate.getState().sessionId === sessionId);
      if (parked !== undefined) {
        switchTo(parked);
        return;
      }
      const settings = into ?? current.getState().settings;
      setModal({ kind: 'loading', title: `Opening ${oneLine(title, 60)}…` });
      try {
        const events = await host.sessionMessages(settings.profileId, settings.providerId, sessionId, settings.cwd);
        setModal(null);
        const next = makeConversation(settings);
        const outcome = next.loadHistory(sessionId, events);
        if (!outcome.ok) {
          next.dispose();
          setNotice(outcome.reason);
          return;
        }
        switchTo(next);
      } catch (error) {
        setModal(null);
        say('error', `Could not open that conversation: ${describeError(error)}`);
      }
    },
    [host, pool, makeConversation, switchTo, say],
  );

  /**
   * The conversation list, opened again.
   *
   * A ref because the list has to be able to reopen itself — naming a row
   * replaces it with the one-line box, and what comes back afterwards has to be
   * a list re-read from the store rather than the stale one that was on screen
   * — and a `useCallback` cannot name itself in its own body. Assigned just
   * below, on every render, so it is always the current closure.
   */
  const resumeAgain = useRef<() => void>(() => undefined);

  const openResumePicker = useCallback(
    async (latest = false) => {
      setModal({ kind: 'loading', title: 'Conversations — reading the store…' });
      try {
        // The picker's own list: one account, this directory. The rail keeps
        // its cross-account, cross-project list.
        const list = await host.listSessions(state.settings.profileId, state.settings.providerId, state.settings.cwd);
        if (list.length === 0) {
          setModal(null);
          say('info', `No stored conversations for ${state.settings.profileLabel} in ${workspace}.`);
          return;
        }
        if (latest) {
          const newest = list[0];
          if (newest !== undefined) await loadSession(newest.id, newest.title);
          return;
        }
        const items: PickerItem[] = list.map((session) => ({
          key: session.id,
          label: oneLine(session.title, 70),
          detail: [formatRelative(session.updatedAt), session.model, session.gitBranch]
            .filter((part): part is string => part !== undefined && part.length > 0)
            .join(' · '),
          ...(session.id === state.sessionId ? { note: 'this conversation' } : {}),
        }));
        const found = (key: string): SessionSummary | undefined => list.find((candidate) => candidate.id === key);
        setModal({
          kind: 'picker',
          title: `Conversations in ${workspace}`,
          items,
          ...(state.sessionId === undefined ? {} : { initialKey: state.sessionId }),
          /*
           * The one picker in here that is genuinely long — every stored
           * conversation in this directory, growing for as long as the
           * directory is worked in — so it is the one that is typed at rather
           * than walked. The rail's keys, on the rail's rows, in the surface
           * that is open when the rail is not on screen.
           */
          filterable: true,
          onPreview: (item) => {
            const session = found(item.key);
            // Pressing Space twice on a row puts the box away, which is the
            // only way out of it that does not also close the list.
            if (session !== undefined) setPreview((shown) => (shown?.id === session.id ? null : session));
          },
          onRename: (item) => {
            const session = found(item.key);
            if (session === undefined) return;
            setModal({
              kind: 'prompt',
              title: 'Name this conversation',
              initial: session.title,
              /*
               * The list is re-read rather than patched, and both ways out do
               * it: a row still showing the old title after a rename would be
               * the screen disagreeing with the store, and Esc out of the name
               * should leave the list exactly where it was found. Waited on
               * first, because a list re-read before the write landed would
               * come back with the name that was just replaced.
               */
              onSubmit: (name) => {
                const named = name.trim();
                if (named.length === 0) {
                  resumeAgain.current();
                  return;
                }
                setModal({ kind: 'loading', title: `Naming it "${oneLine(named, 40)}"…` });
                void renameStoredSession(session.id, named).then(() => {
                  resumeAgain.current();
                });
              },
              onCancel: () => {
                resumeAgain.current();
              },
            });
          },
          onSecondary: [
            {
              key: 'ctrl+a',
              label: 'archive',
              run: (item) => {
                const session = found(item.key);
                if (session === undefined) return;
                setModal(null);
                setPreview(null);
                void archiveRailSession(session);
              },
            },
            {
              key: 'ctrl+p',
              label: 'pin',
              run: (item) => {
                if (found(item.key) !== undefined) togglePinFor(item.key);
              },
            },
          ],
          onCancel: () => {
            setPreview(null);
          },
          onSelect: (item) => {
            const session = found(item.key);
            setModal(null);
            setPreview(null);
            if (session === undefined || session.id === state.sessionId) return;
            void loadSession(session.id, session.title);
          },
        });
      } catch (error) {
        setModal(null);
        say('error', `Could not list conversations: ${describeError(error)}`);
      }
    },
    [host, state.settings, state.sessionId, workspace, say, loadSession, renameStoredSession, archiveRailSession, togglePinFor],
  );
  resumeAgain.current = () => {
    void openResumePicker();
  };

  // `artemis -c` / `--resume <id>`: act once the screen exists.
  const resumedOnLaunch = useRef(false);
  useEffect(() => {
    if (resumedOnLaunch.current || launched.resume === undefined) return;
    resumedOnLaunch.current = true;
    if (launched.resume === 'latest') void openResumePicker(true);
    else void loadSession(launched.resume as SessionId, launched.resume);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------------------------------------------------------------------- */
  /* Pickers                                                                 */
  /* ---------------------------------------------------------------------- */

  const openPicker = useCallback((picker: Omit<PickerModal, 'kind'>) => {
    setModal({ kind: 'picker', ...picker });
  }, []);

  const confirm = useCallback(
    (title: string, yes: string, danger: boolean, onYes: () => void) => {
      openPicker({
        title,
        items: [
          { key: 'no', label: 'Not now' },
          { key: 'yes', label: yes, danger },
        ],
        initialKey: 'no',
        onSelect: (item) => {
          setModal(null);
          if (item.key === 'yes') onYes();
        },
      });
    },
    [openPicker],
  );

  /** The one door to another account, from the picker or the rail. */
  const switchAccount = useCallback(
    (profile: { readonly id: string; readonly label: string; readonly providerId: string; readonly providerLabel: string }) => {
      if (profile.id === state.settings.profileId) return;
      const fresh: ConversationSettings = {
        ...state.settings,
        profileId: profile.id as never,
        providerId: profile.providerId as never,
        profileLabel: profile.label,
        providerLabel: profile.providerLabel,
        model: undefined,
        modelLabel: undefined,
        effort: undefined,
        fastMode: undefined,
        ultracode: undefined,
      };
      const apply = (): void => {
        planFetchedAt.current = 0;
        /*
         * A conversation belongs to the account it started on, so a new one
         * is begun on the other account. While this one is still working it
         * is parked rather than reset — the same rule as `startNew` — so
         * switching account no longer has to wait for a turn to end.
         */
        if (conversation.isLive) {
          switchTo(makeConversation(fresh));
        } else {
          const outcome = conversation.updateSettings(fresh);
          if (!outcome.ok) {
            setNotice(outcome.reason);
            return;
          }
          seedPlanUsage(profile.id);
        }
        say('info', `Now running as ${profile.label} (${profile.providerLabel}). New conversation.`);
      };
      if (state.sessionId !== undefined && !conversation.isLive) {
        confirm('Switching account ends this conversation.', `Switch to ${profile.label} and start fresh`, false, apply);
      } else {
        apply();
      }
    },
    [state.settings, state.sessionId, conversation, confirm, say, seedPlanUsage, switchTo, makeConversation],
  );

  /*
   * The two pickers that cost a subprocess open on the remembered answer and
   * refresh in place, so the wait is paid behind a usable list rather than in
   * front of an empty one. The first launch on a machine still waits: there is
   * nothing to show yet, and a picker with no rows would be worse than a line
   * saying why.
   */
  const openProfilePicker = useCallback(async () => {
    const token = ++pickerToken.current;
    const present = (catalogue: readonly ServerProfile[], metadata: readonly ProfileMetadata[]): Omit<PickerModal, 'kind'> => {
      const keyed = new Map(metadata.map((profile) => [profile.id, profile]));
      const items: PickerItem[] = catalogue.map((row) => {
        const meta = keyed.get(row.id);
        const current = row.id === state.settings.profileId;
        let reason: string | undefined;
        if (!row.available) reason = row.unavailableReason ?? 'not available on this machine';
        else if (row.disabled) reason = 'hidden in Artemis';
        else if (row.auth?.loggedIn === false) reason = 'not signed in';
        else if (meta?.hasApiKey === true) reason = "its key is stored by the desktop app and can't be read here";
        return {
          key: row.id,
          label: row.label,
          detail: `${row.provider.label}${row.auth?.email !== undefined ? ` · ${row.auth.email}` : ''}${current ? ' · current' : ''}`,
          disabled: reason !== undefined,
          ...(reason === undefined ? {} : { reason }),
        };
      });
      return {
        title: 'Accounts',
        items,
        initialKey: state.settings.profileId,
        token,
        onSelect: (item) => {
          setModal(null);
          const row = catalogue.find((candidate) => candidate.id === item.key);
          if (row === undefined) return;
          switchAccount({ id: row.id, label: row.label, providerId: row.provider.id, providerLabel: row.provider.label });
        },
      };
    };
    const remembered = cache.get<readonly ServerProfile[]>(CATALOGUE_KEY);
    if (remembered === undefined) setModal({ kind: 'loading', title: 'Accounts — asking each one how it is…' });
    else openPicker({ ...present(remembered.value, await host.profiles.listMetadata()), hint: `asking each one how it is… · ${PICKER_KEYS}` });
    try {
      const [catalogue, metadata] = await Promise.all([host.catalogue.read(), host.profiles.listMetadata()]);
      cache.set(CATALOGUE_KEY, catalogue);
      const fresh = present(catalogue, metadata);
      if (remembered === undefined) openPicker(fresh);
      else setModal((current) => (current?.kind === 'picker' && current.token === token ? { ...current, ...fresh, hint: undefined } : current));
    } catch (error) {
      if (remembered === undefined) {
        setModal(null);
        say('error', `Could not list accounts: ${describeError(error)}`);
      } else {
        setModal((current) =>
          current?.kind === 'picker' && current.token === token ? { ...current, hint: `could not ask — this is the last answer · ${PICKER_KEYS}` } : current,
        );
      }
    }
  }, [host, cache, state.settings.profileId, openPicker, switchAccount, say]);

  const openSpeedPicker = useCallback(
    (model: ProviderModelOption) => {
      const items: PickerItem[] = [{ key: 'normal', label: 'Normal', detail: 'the model as it comes' }];
      if (model.supportsFastMode === true) items.push({ key: 'fast', label: 'Fast', detail: 'less reasoning, quicker replies' });
      if (model.supportsUltracode === true) items.push({ key: 'ultracode', label: 'Ultracode', detail: 'maximum effort, multi-agent where offered' });
      const current = state.settings.fastMode === true ? 'fast' : state.settings.ultracode === true ? 'ultracode' : 'normal';
      openPicker({
        title: 'Speed',
        items,
        initialKey: current,
        onSelect: (item) => {
          setModal(null);
          conversation.updateSettings({ fastMode: item.key === 'fast', ultracode: item.key === 'ultracode' });
        },
      });
    },
    [openPicker, conversation, state.settings.fastMode, state.settings.ultracode],
  );

  const openEffortPicker = useCallback(
    (model: ProviderModelOption) => {
      const descriptor = descriptors.get(state.settings.providerId);
      const all = descriptor?.effortLevels ?? [];
      const allowed = model.effortLevels === undefined ? all : all.filter((level) => model.effortLevels?.includes(level.id));
      const next = (): void => {
        if (model.supportsFastMode === true || model.supportsUltracode === true) openSpeedPicker(model);
      };
      if (allowed.length === 0) {
        next();
        return;
      }
      openPicker({
        title: `Effort for ${model.label}`,
        items: [
          { key: '', label: 'Default', detail: "the provider's own choice" },
          ...allowed.map((level) => ({ key: level.id, label: level.label, detail: level.note })),
        ],
        initialKey: state.settings.effort ?? '',
        onSelect: (item) => {
          setModal(null);
          conversation.updateSettings({ effort: item.key === '' ? undefined : item.key });
          next();
        },
      });
    },
    [descriptors, state.settings.providerId, state.settings.effort, openPicker, conversation, openSpeedPicker],
  );

  const openModelPicker = useCallback(async () => {
    const token = ++pickerToken.current;
    const present = (listing: ModelListing): Omit<PickerModal, 'kind'> => {
      const items: PickerItem[] = [
        { key: '', label: 'Provider default', detail: 'whatever the CLI would pick' },
        ...listing.models.map((model) => ({
          key: model.id,
          label: model.label,
          detail: model.displayName !== undefined && model.displayName !== model.label ? model.displayName : model.note,
        })),
      ];
      return {
        title: listing.live ? 'Models' : 'Models (built-in list — the account did not confirm it)',
        items,
        initialKey: state.settings.model ?? '',
        token,
        onSelect: (item) => {
          setModal(null);
          if (item.key === '') {
            conversation.updateSettings({ model: undefined, modelLabel: undefined, effort: undefined, fastMode: undefined, ultracode: undefined });
            return;
          }
          const model = listing.models.find((candidate) => candidate.id === item.key);
          if (model === undefined) return;
          conversation.updateSettings({ model: model.id, modelLabel: model.label, effort: undefined, fastMode: undefined, ultracode: undefined });
          openEffortPicker(model);
        },
      };
    };
    const remembered = cache.get<ModelListing>(modelsKey(state.settings.profileId));
    if (remembered === undefined) setModal({ kind: 'loading', title: 'Models — asking the account…' });
    else openPicker({ ...present(remembered.value), hint: `asking the account… · ${PICKER_KEYS}` });
    try {
      const fresh = present(await readModels());
      if (remembered === undefined) openPicker(fresh);
      else setModal((current) => (current?.kind === 'picker' && current.token === token ? { ...current, ...fresh, hint: undefined } : current));
    } catch (error) {
      if (remembered === undefined) {
        setModal(null);
        say('error', `Could not list models: ${describeError(error)}`);
      } else {
        setModal((current) =>
          current?.kind === 'picker' && current.token === token ? { ...current, hint: `could not ask — this is the last list · ${PICKER_KEYS}` } : current,
        );
      }
    }
  }, [cache, readModels, state.settings.profileId, state.settings.model, openPicker, conversation, openEffortPicker, say]);

  const applyMode = useCallback(
    (mode: PermissionMode) => {
      conversation.updateSettings({ permissionMode: mode });
      say('info', `Permission mode: ${MODE_LABEL[mode]}.${conversation.isLive ? ' Takes effect on the next turn.' : ''}`);
    },
    [conversation, say],
  );

  const openModePicker = useCallback(() => {
    const available = PERMISSION_MODES.filter((mode) => state.capabilities.permissionModes.includes(mode));
    openPicker({
      title: `Permission mode — ${state.settings.providerLabel}`,
      items: available.map((mode) => ({
        key: mode,
        label: MODE_LABEL[mode],
        detail: MODE_DETAIL[mode],
        danger: mode === 'bypassPermissions',
      })),
      initialKey: state.settings.permissionMode,
      onSelect: (item) => {
        setModal(null);
        const mode = item.key as PermissionMode;
        if (mode === 'bypassPermissions') {
          confirm('Approve every tool call without asking?', 'Yes — bypass all permission prompts', true, () => {
            bypassConfirmed.current = true;
            applyMode(mode);
          });
        } else {
          applyMode(mode);
        }
      },
    });
  }, [openPicker, state.capabilities.permissionModes, state.settings.providerLabel, state.settings.permissionMode, confirm, applyMode]);

  /**
   * Shift+Tab: the next mode the provider has, wrapping round.
   *
   * The same list the picker builds, in the same order, applied by the same
   * function — the key is another door to `/mode`, not a second opinion about
   * what a mode change is. What it does not do is walk into
   * `bypassPermissions`: that one is reached by agreeing to it, and only once
   * that has happened does the cycle include it. See `bypassConfirmed`.
   *
   * The flash is the whole feedback the keystroke needs. A mode stepped past
   * on the way to another is still a mode the transcript records — `applyMode`
   * writes the line — because what the agent was allowed to do when is part of
   * what happened.
   */
  const cycleMode = useCallback(() => {
    const available = PERMISSION_MODES.filter(
      (mode) =>
        state.capabilities.permissionModes.includes(mode) && (mode !== 'bypassPermissions' || bypassConfirmed.current),
    );
    if (available.length < 2) {
      showFlash(`${state.settings.providerLabel} has one permission mode; /mode says which.`);
      return;
    }
    // A mode the cycle skips — bypass, before it has been agreed to — is not
    // in the list, so `indexOf` is -1 and the step lands on the first: Shift+Tab
    // always leads *out* of it, whatever it cannot lead into.
    const next = available[(available.indexOf(state.settings.permissionMode) + 1) % available.length];
    if (next === undefined || next === state.settings.permissionMode) return;
    applyMode(next);
    showFlash(`permission mode: ${MODE_LABEL[next]}`);
  }, [state.capabilities.permissionModes, state.settings.permissionMode, state.settings.providerLabel, applyMode, showFlash]);

  /* ---------------------------------------------------------------------- */
  /* Tasks and usage                                                         */
  /* ---------------------------------------------------------------------- */

  const describeTask = (task: BackgroundTask): string => {
    const parts = [task.status, task.subagentType ?? task.workflowName ?? task.kind.replace(/^local_/, '')];
    const elapsed = (task.endedAt ?? Date.now()) - task.startedAt;
    if (elapsed > 0) parts.push(formatDuration(elapsed));
    if (task.summary !== undefined) parts.push(oneLine(task.summary, 60));
    return parts.join(' · ');
  };

  /**
   * What one delegated agent did, read out of the provider's own store.
   *
   * Keyed on the agent rather than on a task, because the two are not always
   * the same thing. A `Task`/`Agent` call is filed under exactly the id the
   * task list carries, so for those they coincide; a workflow's agents each
   * write their own transcript under an id nested in the workflow's progress,
   * and those are reachable only from the delegated strip's unfolded rows. One
   * function for both, so `/tasks` and the strip cannot come to disagree about
   * what opening an agent means.
   */
  const openAgentTranscript = useCallback(
    async (agentId: string, described: string) => {
      const sessionId = state.sessionId;
      if (sessionId === undefined) {
        setNotice('No session to read the agent from yet.');
        return;
      }
      setModal({ kind: 'loading', title: `Reading what "${oneLine(described, 50)}" did…` });
      try {
        const events = await host.subagentMessages(
          state.settings.profileId,
          state.settings.providerId,
          sessionId,
          agentId,
          state.settings.cwd,
        );
        setModal({ kind: 'replay', title: oneLine(described, 90), events });
      } catch (error) {
        setModal(null);
        say('error', `Could not read that agent's transcript: ${describeError(error)}`);
      }
    },
    [host, state.sessionId, state.settings, say],
  );

  const openTaskTranscript = useCallback(
    async (task: BackgroundTask) => {
      await openAgentTranscript(task.id, task.description);
    },
    [openAgentTranscript],
  );

  const openTasksPicker = useCallback(() => {
    const tasks = state.tasks.filter((task) => task.ambient !== true);
    if (tasks.length === 0) {
      say('info', 'No background work has been reported in this conversation.');
      return;
    }
    const canRead = state.capabilities.subagentTranscripts;
    openPicker({
      title: 'Background work',
      items: tasks.map((task) => ({
        key: task.id,
        label: oneLine(task.description, 70),
        detail: describeTask(task),
        ...(task.error !== undefined ? { note: oneLine(task.error, 100) } : {}),
      })),
      hint: canRead ? '↑↓ move · Enter opens what it did, or stops it · Esc back' : '↑↓ move · Enter stops a live task · Esc back',
      onSelect: (item) => {
        const task = tasks.find((candidate) => candidate.id === item.key);
        setModal(null);
        if (task === undefined) return;
        const delegated = task.subagentType !== undefined || task.kind.includes('agent') || task.kind.includes('workflow');
        if (delegated && canRead) {
          void openTaskTranscript(task);
        } else if (isTaskLive(task)) {
          confirm(`Stop "${oneLine(task.description, 50)}"?`, 'Stop it', true, () => {
            void conversation.stopTask(task.id).then((outcome) => {
              if (!outcome.ok) setNotice(outcome.reason);
            });
          });
        } else {
          say('info', `${oneLine(task.description, 80)} — ${describeTask(task)}`, task.outputFile === undefined ? undefined : `output: ${task.outputFile}`);
        }
      },
    });
  }, [state.tasks, state.capabilities.subagentTranscripts, openPicker, openTaskTranscript, confirm, conversation, say]);

  const showUsage = useCallback(async () => {
    await refreshPlanUsage(true);
    const usage = conversation.getState().planUsage;
    if (usage === null) {
      say('info', `${state.settings.providerLabel} reports no plan windows for this account.`);
      return;
    }
    if (!usage.available) {
      say('info', usage.unavailableReason ?? 'No plan limits apply to this account.');
      return;
    }
    const lines = usage.windows.map((window) => {
      const used = window.utilization === null ? 'unknown' : `${String(Math.round(window.utilization))}% used`;
      const resets = window.resetsAt === null ? '' : ` · resets ${formatUntil(window.resetsAt)}`;
      return `${window.label.padEnd(14)} ${used}${resets}`;
    });
    say('info', `Plan${usage.subscriptionType !== undefined ? ` · ${usage.subscriptionType}` : ''}`, lines.join('\n'));
  }, [refreshPlanUsage, conversation, say, state.settings.providerLabel]);

  /* ---------------------------------------------------------------------- */
  /* Taking it out, and taking it back                                       */
  /* ---------------------------------------------------------------------- */

  /**
   * This conversation's row in the rail, when the store has one for it.
   *
   * The only place the terminal learns what a conversation is *called*: a
   * title is the provider's, written beside the transcript, and the rail is
   * already reading every account's list. A conversation that has not been
   * saved yet — nothing sent, or sent and not yet listed — has no row and no
   * name, which is a fact the callers below say out loud rather than paper
   * over with the folder's name.
   */
  const currentSession = useMemo(
    () => (state.sessionId === undefined ? undefined : sessions.find((session) => session.id === state.sessionId)),
    [sessions, state.sessionId],
  );

  /**
   * A row for something this terminal did rather than something the model did.
   *
   * The same row `!` writes and the same row a provider's own slash command
   * gets, because it is the same kind of thing: the host did it, and nothing
   * was sampled. See {@link LOCAL_RUN_ID} for why it is not on the provider's
   * numbering.
   */
  const recordCommand = useCallback(
    (name: string, args: string | undefined, output: string, failed = false) => {
      transcript.apply({
        type: 'command.run',
        runId: LOCAL_RUN_ID,
        seq: 0,
        ts: Date.now(),
        command: {
          name,
          ...(args === undefined || args.length === 0 ? {} : { args }),
          ...(output.length === 0 ? {} : { output }),
          ...(failed ? { failed: true } : {}),
        },
      });
    },
    [transcript],
  );

  /**
   * Put text on the clipboard and say which of the two routes it took.
   *
   * "Copied" and "sent to the terminal" are different promises and the flash
   * keeps them apart: OSC 52 hands the bytes to whatever emulator the person
   * is sitting in front of, through however many hops of SSH, and no terminal
   * acknowledges it. See `clipboard.ts`.
   */
  const putOnClipboard = useCallback(
    async (text: string) => {
      const method = await copyText(text);
      showFlash(method === 'native' ? 'copied' : method === 'osc52' ? 'sent to the terminal' : 'no way to copy here');
    },
    [showFlash],
  );

  /**
   * `/copy` — the last reply, or one piece of it.
   *
   * Source rather than the rendering on screen: the point of copying a reply
   * is to paste it somewhere that renders it again, and what the terminal drew
   * is ANSI escapes and hard-wrapped lines. A reply with fenced blocks opens a
   * list first, because the thing people mean most of the time is the command
   * in the middle of the explanation rather than the explanation.
   */
  const copyLastReply = useCallback(() => {
    const text = lastAssistantText(transcript);
    if (text === null) {
      showFlash('nothing to copy');
      return;
    }
    const blocks = codeBlocksOf(text);
    if (blocks.length === 0) {
      void putOnClipboard(text);
      return;
    }
    openPicker({
      title: 'Copy',
      items: [
        { key: 'all', label: 'the whole reply', detail: countOfLines(text) },
        ...blocks.map((block, index) => {
          const opening = block.code.split('\n').find((line) => line.trim().length > 0) ?? '';
          return {
            key: String(index),
            // The language and the first line that has anything on it: between
            // them they identify a block without the person having to count
            // fences back through the reply.
            label: [block.lang, oneLine(opening, 60)].filter((part) => part.length > 0).join(' · ') || 'an empty block',
            detail: countOfLines(block.code),
          };
        }),
      ],
      onSelect: (item) => {
        setModal(null);
        if (item.key === 'all') {
          void putOnClipboard(text);
          return;
        }
        const block = blocks[Number(item.key)];
        if (block !== undefined) void putOnClipboard(block.code);
      },
    });
  }, [transcript, showFlash, putOnClipboard, openPicker]);

  /**
   * `/export` — the whole conversation as a markdown file.
   *
   * Written beside itself and renamed into place, as `preferences.ts` writes:
   * a rename is atomic on every filesystem this runs on, and the failure it
   * rules out — a half-written export that someone opens and believes — is the
   * one failure a saved file must not have.
   *
   * The name is the caller's when they gave one, relative to where the
   * conversation is working rather than to wherever this process happens to
   * have been started. Otherwise it is `exportFilename`'s, which carries the
   * conversation's own name and the time, because exporting twice in an
   * afternoon is the normal case.
   */
  const exportConversation = useCallback(
    (args: string) => {
      const title = currentSession?.title;
      const startedAt = currentSession?.createdAt;
      const markdown = transcriptToMarkdown(transcript, {
        ...(title === undefined ? {} : { title }),
        ...(startedAt === undefined ? {} : { startedAt }),
      });
      if (markdown.trim().length === 0) {
        showFlash('nothing to export');
        return;
      }
      const named = args.length > 0 ? args : exportFilename(title);
      const path = isAbsolute(named) ? named : resolvePath(state.settings.cwd, named);
      void (async () => {
        try {
          const temp = `${path}.${String(process.pid)}.tmp`;
          await writeFile(temp, markdown, 'utf8');
          await rename(temp, path);
        } catch (error) {
          showFlash('could not write that file');
          say('error', `Could not write ${path}: ${describeError(error)}`);
          return;
        }
        showFlash(shortenPath(path, homedir()));
        recordCommand('export', args.length > 0 ? args : undefined, path);
      })();
    },
    [currentSession, transcript, state.settings.cwd, showFlash, say, recordCommand],
  );

  /**
   * One file's edits, oldest first, as the transcript draws them.
   *
   * Newest last on purpose: a file read top to bottom should end on the edit
   * that left it as it is now, and the ledger hands its changes back newest
   * first because that is the order `/undo` wants them in.
   */
  const diffOfFile = useCallback(
    (file: ChangedFile, columns: number): readonly string[] =>
      conversation.changes
        .changes()
        .filter((change) => change.path === file.path)
        .reverse()
        .flatMap((change, index) => [
          ...(index === 0 ? [] : ['']),
          // No cap: this is the view someone opened *because* the transcript
          // capped it. The gutter is on for the same reason — there is room,
          // and a line number is how a diff is talked about.
          ...renderDiff(change.edit, Number.POSITIVE_INFINITY, { columns, numbers: 'on' }),
        ]),
    [conversation],
  );

  /**
   * `/diff` — what changed, from two directions.
   *
   * The ledger answers "what has this conversation done", which is the
   * question during a turn; `git` answers "what is different from the last
   * commit, whoever changed it", which is the question before committing.
   * Both are offered because neither is a superset: the ledger sees edits in a
   * directory that is not a repository at all, and git sees the work the
   * person did themselves.
   *
   * Waited on first. The ledger is fed from an event handler that cannot wait
   * for a disk read, so a `/diff` typed the instant a turn ends would
   * otherwise be missing that turn's last edit — see `changesSettled`.
   */
  const openDiff = useCallback(() => {
    void (async () => {
      await conversation.changesSettled();
      const files = conversation.changes.files();
      const columns = Math.max(20, mainWidth - TEXT_VIEW_CHROME);

      const workingTree = async (): Promise<void> => {
        setModal({ kind: 'loading', title: 'Working tree — asking git…' });
        const result = await gitDiff(conversation.getState().settings.cwd);
        setModal(null);
        if (!result.ok) {
          showFlash(result.reason);
          return;
        }
        if (result.text.trim().length === 0) {
          showFlash('nothing changed');
          return;
        }
        setModal({ kind: 'text', title: `Working tree · ${workspace}`, lines: result.text.split('\n') });
      };

      // Nothing recorded means there is only one row to offer, and a picker of
      // one row is a keystroke asking to be skipped.
      if (files.length === 0) {
        await workingTree();
        return;
      }

      const labels = fileLines(files, columns);
      openPicker({
        title: 'What changed',
        items: [
          { key: WORKING_TREE_KEY, label: 'working tree', detail: 'everything different from the last commit' },
          ...files.map((file, index) => ({ key: String(index), label: labels[index] ?? file.label })),
        ],
        hint: '↑↓ move · Enter opens the diff · Esc back',
        onSelect: (item) => {
          setModal(null);
          if (item.key === WORKING_TREE_KEY) {
            void workingTree();
            return;
          }
          const file = files[Number(item.key)];
          if (file === undefined) return;
          setModal({ kind: 'text', title: file.label, lines: diffOfFile(file, columns) });
        },
      });
    })();
  }, [conversation, mainWidth, workspace, openPicker, showFlash, diffOfFile]);

  /**
   * `/undo` — the last file change, taken back.
   *
   * The whole of the rule is the ledger's: it refuses unless the file still
   * looks exactly as it did when the call finished, so a later edit, a save
   * from an editor or a formatter all mean "cannot undo" rather than a write
   * over work nobody asked to lose. What is here is the waiting, the re-read
   * of the totals — the one thing that moves them without an event behind it —
   * and saying which of the three happened.
   */
  const undoLastChange = useCallback(() => {
    void (async () => {
      await conversation.changesSettled();
      const result = await conversation.changes.undo();
      conversation.refreshChanges();
      if (!result.ok) {
        showFlash(`cannot undo: ${result.reason}`);
        recordCommand('undo', undefined, `cannot undo: ${result.reason}`, true);
        return;
      }
      const said = `${result.action} ${result.path}`;
      showFlash(said);
      recordCommand('undo', undefined, said);
    })();
  }, [conversation, showFlash, recordCommand]);

  /**
   * `/pin` — hold this conversation at the top of its folder.
   *
   * A judgement about a conversation rather than about an account, so it is
   * remembered in the preferences and not in the cache, and it is the session
   * id that is written down: a title is the provider's to change and a path is
   * the directory's, while the id is what the conversation *is*.
   */
  const togglePin = useCallback(() => {
    const sessionId = state.sessionId;
    if (sessionId === undefined) {
      showFlash('nothing to pin yet');
      return;
    }
    togglePinFor(sessionId);
  }, [state.sessionId, showFlash, togglePinFor]);

  /**
   * `/title` — name *this* conversation.
   *
   * Which one, and the words for having none yet; the writing is
   * {@link renameStoredSession}'s, because Ctrl+R over the conversation list
   * does the same thing to a row that is usually not this one.
   */
  const renameConversation = useCallback(
    (name: string) => {
      const sessionId = state.sessionId;
      if (sessionId === undefined) {
        showFlash('nothing to name yet');
        return;
      }
      if (name.length === 0) {
        showFlash('/title <name> names this conversation');
        return;
      }
      void renameStoredSession(sessionId, name);
    },
    [state.sessionId, showFlash, renameStoredSession],
  );

  /* ---------------------------------------------------------------------- */
  /* Commands and messages                                                   */
  /* ---------------------------------------------------------------------- */

  const attach = useCallback(
    async (args: string) => {
      if (args.length === 0) {
        say(
          'info',
          pendingAttachments.length === 0
            ? 'Nothing attached. /attach <path> queues a file for the next message.'
            : `Attached: ${pendingAttachments.map((entry) => entry.name).join(', ')}`,
        );
        return;
      }
      if (args === 'clear' || args === 'none') {
        setPendingAttachments([]);
        return;
      }
      const result = await readAttachment(args, state.settings.cwd);
      if (!result.ok) {
        setNotice(result.reason);
        return;
      }
      const kind = result.attachment.kind;
      if (kind === 'image' && !state.capabilities.imageInput) {
        setNotice(`${state.settings.providerLabel} cannot take images.`);
        return;
      }
      if (kind === 'file' && !state.capabilities.fileInput) {
        setNotice(`${state.settings.providerLabel} cannot take file attachments.`);
        return;
      }
      const name = result.attachment.kind === 'image' ? result.attachment.name ?? 'image' : result.attachment.name;
      setPendingAttachments((current) => [...current, { name, attachment: result.attachment }]);
    },
    [pendingAttachments, state.settings.cwd, state.settings.providerLabel, state.capabilities, say],
  );

  /**
   * Begin again, on the same account and in the same directory.
   *
   * A conversation still working is left to work — parked in the pool, shown
   * in the rail — and the new one starts beside it. Only an idle conversation
   * is reset in place, which costs nothing and keeps the pool small.
   */
  const startNew = useCallback(() => {
    const current = conversationRef.current;
    if (current.isLive) {
      switchTo(makeConversation(current.getState().settings));
      return;
    }
    const outcome = current.reset();
    if (!outcome.ok) setNotice(outcome.reason);
    else setScroll(0);
  }, [makeConversation, switchTo]);

  /**
   * Work in `target`, starting fresh there.
   *
   * A conversation belongs to the directory it started in — that is what the
   * provider files it under and what the rail groups it by — so moving is a
   * new conversation rather than the same one relocated, and the message says
   * so. The path arrives already chosen from a list, but it is still checked:
   * a recent folder is a folder that existed when a conversation ran in it,
   * which is not the same as one that exists now.
   */
  const moveToDirectory = useCallback(
    async (target: string) => {
      if (target === conversationRef.current.getState().settings.cwd) {
        startNew();
        return;
      }
      try {
        if (!(await stat(target)).isDirectory()) {
          say('error', `${target} is not a directory.`);
          return;
        }
      } catch {
        say('error', `${target} is gone, or cannot be read.`);
        return;
      }
      // A new conversation there, rather than this one moved: the directory
      // is what the provider files a conversation under, and the one on
      // screen may still be working in the directory it started in.
      switchTo(makeConversation({ ...conversationRef.current.getState().settings, cwd: target }));
      say('info', `Working in ${target}. New conversation.`);
    },
    [makeConversation, switchTo, say, startNew],
  );

  /**
   * Walk the filesystem for a folder nothing has run in yet.
   *
   * One picker per directory, rebuilt on each step, rather than a component
   * with its own cursor: the rows are a list to choose from like every other
   * list in here, and reusing the picker means the scrolling, the keys and the
   * look are the ones already learned. The first row chooses where you have
   * arrived, so accepting a folder is Enter and there is no second key.
   */
  const openBrowser = useCallback(
    (path: string): void => {
      void (async () => {
        const home = homedir();
        let entries: Dirent[];
        try {
          entries = await readdir(path, { withFileTypes: true });
        } catch {
          say('error', `Cannot read ${path}.`);
          setModal(null);
          return;
        }
        const rows = browseRows(path, entries);
        setModal({
          kind: 'picker',
          title: `Browse — ${shortenPath(path, home)}`,
          items: rows.map((row, i) => ({
            key: String(i),
            label: browseRowLabel(row, home),
            ...(row.kind === 'choose' ? { detail: shortenPath(path, home) } : {}),
          })),
          hint: '↑↓ move · Enter open · first row chooses · Esc back',
          onSelect: (item) => {
            const row = rows[Number(item.key)];
            if (row === undefined) return;
            if (row.kind === 'choose') {
              setModal(null);
              void moveToDirectory(row.path);
              return;
            }
            openBrowser(row.path);
          },
        });
      })();
    },
    [say, moveToDirectory],
  );

  /**
   * Where to work: the folders already worked in, and browsing for one that
   * is not there yet.
   *
   * Recents first and browsing last, because the folder someone wants is
   * nearly always one they have been in before — the same order, and the same
   * reasoning, as the control above the desktop's composer.
   */
  const openDirectoryPicker = useCallback(() => {
    const home = homedir();
    const recents = recentDirectories(sessions, state.settings.cwd, home);
    setModal({
      kind: 'picker',
      title: 'New conversation in…',
      initialKey: state.settings.cwd,
      items: [
        ...recents.map((recent) => ({
          key: recent.path,
          label: recent.label,
          ...(recent.path === state.settings.cwd
            ? { detail: 'here' }
            : recent.count > 0
              ? { detail: `${formatRelative(recent.updatedAt)} · ${String(recent.count)}` }
              : {}),
        })),
        { key: BROWSE_KEY, label: 'Browse folders…', detail: 'somewhere new' },
      ],
      onSelect: (item) => {
        if (item.key === BROWSE_KEY) {
          openBrowser(browseStart(state.settings.cwd));
          return;
        }
        setModal(null);
        void moveToDirectory(item.key);
      },
    });
  }, [sessions, state.settings.cwd, moveToDirectory, openBrowser]);

  const runCommand = useCallback(
    (command: Command) => {
      switch (command.name) {
        case 'help': {
          /*
           * The whole map, grouped, rather than the slash commands alone. The
           * overlay and this print the same rows from the same function, so
           * what `/help` says and what `?` draws cannot drift apart — which is
           * the divergence `keymap.ts` exists to end. The commands are still
           * here; they are the last group, as they are in the map.
           */
          const lines = helpLines(mainWidth);
          const width = lines.reduce((widest, line) => Math.max(widest, line.key.length), 0);
          const printed: string[] = [];
          for (const line of lines) {
            if (line.group !== undefined) printed.push(printed.length === 0 ? line.group : `\n${line.group}`);
            printed.push(`  ${line.key.padEnd(width)}  ${line.does}${line.planned === true ? ' (soon)' : ''}`);
          }
          say('info', 'Keys', printed.join('\n'));
          return;
        }
        case 'cwd':
          openDirectoryPicker();
          return;
        case 'quit':
          exit();
          return;
        case 'new':
          startNew();
          return;
        case 'profile':
          void openProfilePicker();
          return;
        case 'model':
          if (command.args.length > 0) {
            conversation.updateSettings({ model: command.args, modelLabel: command.args, effort: undefined });
            say('info', `Model: ${command.args}`);
            return;
          }
          void openModelPicker();
          return;
        case 'mode':
          if (command.args.length > 0) {
            const wanted = command.args;
            if (!isPermissionMode(wanted)) {
              setNotice(`"${wanted}" is not a permission mode. Try /mode with no argument.`);
            } else if (!state.capabilities.permissionModes.includes(wanted)) {
              setNotice(`${state.settings.providerLabel} does not have a "${wanted}" mode.`);
            } else if (wanted === 'bypassPermissions') {
              confirm('Approve every tool call without asking?', 'Yes — bypass all permission prompts', true, () => {
                bypassConfirmed.current = true;
                applyMode(wanted);
              });
            } else {
              applyMode(wanted);
            }
            return;
          }
          openModePicker();
          return;
        case 'resume':
          if (command.args === 'latest' || command.args === 'last') void openResumePicker(true);
          else if (command.args.length > 0) void loadSession(command.args as SessionId, command.args);
          else void openResumePicker();
          return;
        case 'attach':
          void attach(command.args);
          return;
        case 'copy':
          copyLastReply();
          return;
        case 'export':
          exportConversation(command.args);
          return;
        case 'diff':
          openDiff();
          return;
        case 'undo':
          undoLastChange();
          return;
        case 'pin':
          togglePin();
          return;
        case 'title':
          renameConversation(command.args);
          return;
        case 'tasks':
          openTasksPicker();
          return;
        case 'usage':
          void showUsage();
          return;
        default:
          return;
      }
    },
    [
      say,
      mainWidth,
      state.settings,
      state.capabilities.permissionModes,
      exit,
      conversation,
      startNew,
      openProfilePicker,
      openModelPicker,
      openModePicker,
      openResumePicker,
      loadSession,
      attach,
      copyLastReply,
      exportConversation,
      openDiff,
      undoLastChange,
      togglePin,
      renameConversation,
      openTasksPicker,
      showUsage,
      confirm,
      applyMode,
    ],
  );

  const submit = useCallback(
    (text: string, mentions: readonly string[] = [], images: readonly PastedImage[] = []) => {
      setNotice(undefined);
      const command = parseCommand(text);
      if (command !== null) {
        runCommand(command);
        return;
      }
      /*
       * An image pasted into the box with Ctrl+V. There is no file for it —
       * the bytes came off the clipboard — so `attachments.ts` builds the same
       * `Attachment` from what is in hand. A provider that cannot take images
       * gets none, and says so rather than dropping one silently; the `[Image
       * #1]` left in the text is still where it was meant.
       */
      const pasted = state.capabilities.imageInput
        ? images.flatMap((image) => {
            const attachment = attachmentFromBytes(image.name, image.mediaType, image.bytes);
            return attachment === null ? [] : [attachment];
          })
        : [];
      const attachments = [...pendingAttachments.map((entry) => entry.attachment), ...pasted];
      setPendingAttachments([]);
      setScroll(0);
      if (pasted.length < images.length) {
        setNotice(
          state.capabilities.imageInput
            ? 'A pasted image was too large to send.'
            : `${state.settings.providerLabel} cannot take images.`,
        );
      }
      /*
       * Remembered here and not in `Conversation`, because what is remembered
       * is what a person typed: this is every submission that leaves the
       * composer as a message or a steer, and none of the slash commands the
       * terminal answers itself — those returned above, and `/model` is not a
       * prompt anybody wants Up to hand back. It is written down before the
       * provider is asked, so a message the run refuses is still one keystroke
       * from being retyped. Blank text and an immediate repeat are dropped by
       * `history.ts`, which is where that rule belongs.
       */
      history.append({
        text,
        cwd: state.settings.cwd,
        ...(state.sessionId === undefined ? {} : { sessionId: state.sessionId }),
      });
      /*
       * An `@path` is a file the message is about, so it travels as one — read
       * with `/attach`'s own reader and sent beside whatever was already
       * queued. The `@path` stays in the text, because that is what tells the
       * agent which file was meant where; the attachment is what saves it a
       * round trip to read it. Anything the reader will not take — a
       * directory, a path deleted since the index was listed, a kind this
       * provider cannot accept — is simply not attached, and the words remain
       * exactly as they were typed.
       */
      void (async () => {
        const read = await Promise.all(mentions.map((path) => readAttachment(path, state.settings.cwd)));
        const named = read.flatMap((result) => {
          if (!result.ok) return [];
          const accepts = result.attachment.kind === 'image' ? state.capabilities.imageInput : state.capabilities.fileInput;
          return accepts ? [result.attachment] : [];
        });
        const outcome = await conversation.send(text, [...attachments, ...named]);
        if (!outcome.ok) {
          setNotice(outcome.reason);
          // Not lost: a refused message keeps its attachments for the retry.
          if (attachments.length > 0) setPendingAttachments(pendingAttachments);
        }
      })();
    },
    [
      conversation,
      runCommand,
      pendingAttachments,
      history,
      state.capabilities,
      state.settings.cwd,
      state.settings.providerLabel,
      state.sessionId,
    ],
  );

  /* ---------------------------------------------------------------------- */
  /* The terminal, lent out                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * Hand the whole terminal to `$EDITOR`, and take it back.
   *
   * Two programs cannot own one terminal: `vim` wants the alternate screen,
   * raw mode and standard input, and Ink is holding all three. Ink 7 knows
   * this and does the entire dance behind `useApp().suspendTerminal` — it
   * flushes whatever render is pending, erases its own frame, turns off the
   * kitty protocol it may have negotiated, writes `\x1b[?1049l` to leave the
   * alternate screen, and drops raw mode and bracketed paste; on the way back
   * it re-enters the alternate screen, re-enables the protocol, retakes raw
   * mode, throws away the frame it diffs against and forces a full redraw. Ink
   * restores all of it even when the callback throws, which is the reason to
   * use it rather than to write the escapes out here: a half-suspended
   * terminal is a dead prompt, and there is no key left to fix it with.
   *
   * What it cannot do is prove anything about a real terminal from a test —
   * the whole sequence is writes to a TTY and reads from one. See the report:
   * the escape sequences and the order are Ink's, verified by reading it; what
   * `$EDITOR` looks like on the way in and out has to be tried by hand.
   */
  const editExternally = useCallback(
    async (text: string): Promise<string | undefined> => {
      let result: ExternalEditResult | undefined;
      try {
        await suspendTerminal(async () => {
          result = await editInExternalEditor(text);
        });
      } catch (error) {
        setNotice(`Could not hand over the terminal: ${describeError(error)}`);
        return undefined;
      }
      if (result === undefined) return undefined;
      if (!result.ok) {
        setNotice(`Could not edit the message: ${result.reason}`);
        return undefined;
      }
      return result.text;
    },
    [suspendTerminal],
  );

  /**
   * A line typed at the composer's `$`.
   *
   * The rules of running it are `shell.ts`'s; what is here is the two things
   * that can be done with the answer. `!cmd` puts it in the transcript as a
   * command row — the same row a provider's own slash command gets, because
   * this is the same kind of thing: the host did it, and no model was asked.
   * `!!cmd` hands it to the agent as a message instead, fenced, with the
   * command named above it, which is the short way to ask "why does this say
   * that" about something that just happened.
   *
   * The line is written to the prompt history with its `!` in front, which is
   * the whole of what makes ↑ at the `$` a shell history: one file, and a
   * prefix that says which list an entry belongs to.
   */
  const runShellLine = useCallback(
    (command: string, options: { readonly send: boolean }) => {
      const cwd = state.settings.cwd;
      history.append({
        text: `!${options.send ? '!' : ''}${command}`,
        cwd,
        ...(state.sessionId === undefined ? {} : { sessionId: state.sessionId }),
      });
      setFlash(`running: ${oneLine(command, 48)}`);
      setScroll(0);
      void (async () => {
        const result = await runShell(command, cwd);
        setFlash(undefined);
        if (options.send) {
          submit(`Ran \`${command}\`:\n\`\`\`\n${result.output}\n\`\`\``);
          return;
        }
        const cut = command.search(/\s/u);
        const args = cut === -1 ? undefined : command.slice(cut).trim();
        transcript.apply({
          type: 'command.run',
          // Not a run: the seq counter belongs to the provider's stream, and a
          // run id of its own is what keeps this out of that numbering.
          runId: SHELL_RUN_ID,
          seq: 0,
          ts: Date.now(),
          command: {
            name: cut === -1 ? command : command.slice(0, cut),
            ...(args === undefined || args.length === 0 ? {} : { args }),
            ...(result.output.length === 0 ? {} : { output: result.output }),
            ...(result.failed ? { failed: true } : {}),
          },
          // Which table the name came from. Nothing looked `git` up in a
          // command list and there is no `/git`, so the row wears a `$`
          // rather than a slash — and keeps it through a redraw.
          source: 'shell',
        });
      })();
    },
    [history, state.settings.cwd, state.sessionId, submit, transcript],
  );

  /* ---------------------------------------------------------------------- */
  /* The window, from outside                                                */
  /* ---------------------------------------------------------------------- */

  /*
   * Artemis is the one agent terminal where several conversations work at
   * once, which makes the window's own chrome the only channel it has to
   * someone who has tabbed away. `terminal.ts` is all of the bytes and none of
   * the policy; this is the policy.
   *
   * Three signals, three different questions:
   *
   *  - The **title** answers "what is Artemis doing", across the whole pool
   *    rather than for whichever conversation happens to be on screen — the
   *    person reading a taskbar button cannot see which one that is. The
   *    reduction is `titleStateOf`, which is pure and tested; this is the
   *    effect that writes its answer out.
   *  - The **taskbar light** answers "is this window still busy", and belongs
   *    to the conversation in front of you: it is the window's own progress,
   *    and a parked conversation's turn is reported by the rail.
   *  - The **bell** answers "do I need to come back", and waits until nobody
   *    is looking. `AttentionTimer` is that rule — every keystroke pushes both
   *    kinds back out, so a notification never fires at someone mid-sentence.
   */

  /** One timer for the process, built on first render and never replaced. */
  const attention = useRef<AttentionTimer | null>(null);
  attention.current ??= new AttentionTimer();
  useEffect(
    () => () => {
      attention.current?.disarmAll();
    },
    [],
  );

  /**
   * What this conversation is called, and a mirror of it for the callbacks.
   *
   * The title effect wants the value it rendered with; a notification wants
   * the value at the moment it fires, which may be a minute later and by then
   * may be a name the rail had not read when the bell was armed.
   */
  const conversationTitle = currentSession?.title;
  const conversationName = useRef<string | undefined>(undefined);
  conversationName.current = conversationTitle;

  const chrome = useMemo(
    () => titleStateOf(pool.map((alive) => alive.getState())),
    // The same two signals the rail's activity map watches: `parkedTick` says
    // a parked conversation moved, `state` that the one on screen did.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pool, parkedTick, state],
  );

  useEffect(() => {
    // The folder is the subject when the conversation has no name yet, which
    // `titleFor` arranges: `◇ ready · (artemis)` would be a hole where a name
    // should be.
    setTitle(
      titleFor({
        state: chrome.state,
        ...(conversationTitle === undefined ? {} : { title: conversationTitle }),
        folder: workspace,
        needing: chrome.needing,
      }),
    );
  }, [chrome.state, chrome.needing, conversationTitle, workspace]);

  /**
   * When the last turn failed, so the light is not cleared out from under its
   * own red. `progressState('done')` and `'clear'` are the same sequence, and
   * the status going idle arrives on the heels of the `run.end` that failed.
   */
  const failedAt = useRef(0);
  /**
   * Which state of the light a pending clear belongs to.
   *
   * A turn started inside the five seconds takes the bar back to working, and
   * the timer that was going to clear the red must not then clear *that* — a
   * pulse that stops halfway through a turn is a worse lie than a red bar that
   * outstays its welcome.
   */
  const progressGeneration = useRef(0);

  useEffect(() => {
    const off = conversation.subscribeEvents((event) => {
      if (event.type !== 'run.end' || event.reason !== 'error') return;
      failedAt.current = Date.now();
      const generation = ++progressGeneration.current;
      progressState('error');
      const clearing = setTimeout(() => {
        if (progressGeneration.current === generation) progressState('clear');
      }, PROGRESS_ERROR_MS);
      clearing.unref?.();
    });
    return off;
  }, [conversation]);

  useEffect(() => {
    if (live) {
      progressGeneration.current += 1;
      progressState('working');
      return;
    }
    // The `run.end` that failed has already lit the bar red, and the status
    // going idle arrives on its heels; `done` and `clear` are the same
    // sequence, so letting this through would take the red straight back off.
    if (Date.now() - failedAt.current < PROGRESS_ERROR_MS) return;
    progressState('done');
  }, [live]);

  /**
   * The first conversation anywhere in the pool that has stopped to ask.
   *
   * Anywhere, because the whole reason a parked conversation is worth a bell
   * is that its question is invisible: the rail shows a glyph, and the rail is
   * not what the person is looking at.
   */
  const waiting = useMemo(() => {
    for (const alive of pool) {
      const asking = alive.getState();
      const request = asking.pendingPermissions[0];
      if (request === undefined) continue;
      const named = asking.sessionId === undefined ? undefined : sessions.find((row) => row.id === asking.sessionId)?.title;
      return { title: named, tool: request.toolName };
    }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pool, parkedTick, state, sessions]);

  /*
   * Read at the moment the bell rings rather than captured when it was armed:
   * six seconds is long enough for the rail to have learned the conversation's
   * name, and a notification that says which one is asking is the whole value
   * of the notification.
   */
  const waitingNow = useRef(waiting);
  waitingNow.current = waiting;
  const someoneWaiting = waiting !== undefined;

  useEffect(() => {
    const timer = attention.current;
    if (timer === null) return;
    if (!someoneWaiting) {
      timer.disarm('needs-you');
      return;
    }
    timer.arm('needs-you', () => {
      const asking = waitingNow.current;
      notify(
        noticeFor('needs-you', {
          ...(asking?.title === undefined ? {} : { conversation: asking.title }),
          ...(asking?.tool === undefined ? {} : { tool: asking.tool }),
        }),
      );
    });
  }, [someoneWaiting]);

  /**
   * Whether the conversation on screen was running the last time this looked.
   *
   * A finished turn is a *transition* and not a state: a conversation resumed
   * from the store is idle without having just finished anything, and
   * switching from a live conversation to a parked idle one is not the end of
   * a turn either. So the conversation is remembered beside the flag, and only
   * the same one going from live to idle arms the bell.
   */
  const lastTurn = useRef<{ readonly conversation: Conversation; readonly live: boolean } | null>(null);
  useEffect(() => {
    const timer = attention.current;
    const previous = lastTurn.current;
    lastTurn.current = { conversation, live };
    if (timer === null) return;
    if (live) {
      // A new turn is the answer to the last one; nothing is owed about it.
      timer.disarm('finished');
      return;
    }
    if (previous === null || previous.conversation !== conversation || !previous.live) return;
    timer.arm('finished', () => {
      const said = lastAssistantText(conversation.transcript);
      notify(
        noticeFor('finished', {
          ...(conversationName.current === undefined ? {} : { conversation: conversationName.current }),
          ...(said === null ? {} : { reply: said }),
        }),
      );
    });
  }, [conversation, live]);

  /* ---------------------------------------------------------------------- */
  /* Who needs you, and what you missed                                      */
  /* ---------------------------------------------------------------------- */

  /*
   * The pool's other half of the bargain.
   *
   * Several conversations working at once buys you parallelism and hands you
   * a new problem with it: the thing that wants you is, by construction, not
   * the thing you are looking at. The rail answers "which one" with a glyph
   * per row, and a glyph only works on somebody who thought to look. These
   * two do the looking for them.
   *
   *  - **Ctrl+]** goes to the next conversation with a claim on you — every
   *    one that is stuck on a permission first, then every one whose turn
   *    ended since you last had it on screen. `needsYou` is that ordering,
   *    pure and tested; the same list is the count the status line draws, so
   *    the number beside the composer and the conversation the key opens can
   *    never disagree.
   *  - **The welcome-back line** is for the other direction: not "where
   *    should I go" but "what did I miss", on the keystroke that ends three
   *    minutes of stillness. `awayRecap` writes it.
   *
   * Both are built from `runEnds` and `askedAt` above, which this is where
   * they are filled in. One subscription per pooled conversation, taken off
   * the event stream rather than off the state, because a run's length and
   * its cost are on `run.end` and nowhere else — `ConversationState` keeps
   * what is true *now*, and both of these are facts about a turn that is
   * over.
   */
  useEffect(() => {
    // A conversation dropped by `prunePool` is never coming back as the same
    // object, so what was written under its key is dead weight. Pruned here
    // rather than in `switchTo` so that one rule — "the pool is what exists" —
    // governs all three maps.
    const alive = new Set(pool.map((parked) => keyFor(parked)));
    for (const remembered of [seenAt.current, runEnds.current, askedAt.current]) {
      for (const key of [...remembered.keys()]) if (!alive.has(key)) remembered.delete(key);
    }
    const offs = pool.map((parked) => {
      const key = keyFor(parked);
      /*
       * Which run is this conversation's own turn.
       *
       * A conversation forwards its *siblings'* events as well — work the
       * provider started beside the turn, which lands in the same transcript —
       * and a sibling's `run.end` is not the end of anybody's turn. The state
       * says which run is the conversation's while one is in flight and clears
       * it as that run ends, so it is remembered from the events that came
       * before rather than asked for at the one moment it is gone.
       */
      let ownRun = parked.getState().runId;
      return parked.subscribeEvents((event) => {
        ownRun = parked.getState().runId ?? ownRun;
        if (event.type === 'permission.request') {
          askedAt.current.set(key, Date.now());
          return;
        }
        if (event.type !== 'run.end' || event.runId !== ownRun) return;
        runEnds.current.set(key, {
          // The host's clock and not the provider's: this is compared against
          // the moment of a keystroke, which only this process saw.
          at: Date.now(),
          durationMs: event.durationMs,
          costUsd: event.usage?.costUsd,
          failed: event.reason === 'error',
        });
      });
    });
    return () => {
      for (const off of offs) off();
    };
  }, [pool, keyFor]);

  /**
   * Where each conversation sits in the rail, by session id.
   *
   * Ctrl+] walks the pool in the order the eye is about to travel rather than
   * in the order conversations happened to be opened, which is what makes
   * repeated presses feel like going down a list instead of being thrown
   * about one. A conversation the rail has no row for — nothing sent in it
   * yet, or a filter is hiding it — sorts to the end rather than out: the
   * order decides which one is *next*, never which ones count.
   */
  const railOrder = useMemo(() => {
    const at = new Map<string, number>();
    rail.forEach((row, index) => {
      if (row.kind === 'session') at.set(row.session.id, index);
    });
    return at;
  }, [rail]);

  /** Every conversation with a claim on you, in the order Ctrl+] will visit them. */
  const needing = useMemo(() => {
    const ranked = [...pool].sort(
      (a, b) =>
        (railOrder.get(a.getState().sessionId ?? '') ?? Number.MAX_SAFE_INTEGER) -
        (railOrder.get(b.getState().sessionId ?? '') ?? Number.MAX_SAFE_INTEGER),
    );
    const looked = new Map(seenAt.current);
    // The one on the screen is being looked at now, whatever the map last
    // recorded about it. Written here rather than by an effect because an
    // effect runs after the render that would already have counted it.
    looked.set(keyFor(conversation), Date.now());
    return needsYou(
      ranked.map((parked) => {
        const parkedState = parked.getState();
        return {
          key: keyFor(parked),
          status: parkedState.status,
          pendingPermissions: parkedState.pendingPermissions,
          finishedAt: runEnds.current.get(keyFor(parked))?.at,
        };
      }),
      looked,
    );
    // The same two signals the rail's activity map watches — `parkedTick` for
    // a parked conversation, `state` for the one on screen — plus the rail's
    // own order.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pool, parkedTick, state, conversation, railOrder, keyFor]);

  /** Read at the moment the key is pressed, not when the handler was built. */
  const needingNow = useRef<readonly Needing[]>(needing);
  needingNow.current = needing;

  /**
   * Ctrl+]: go to whoever is waiting.
   *
   * The step is always to the one *after* the current conversation in the
   * queue, so a second press walks on instead of staying put — and since
   * arriving somewhere counts as looking at it, the "finished" half of the
   * queue drains as you go while the stuck half stays until the questions are
   * answered, which is exactly the difference between the two.
   *
   * A conversation with no claim of its own is not in the queue at all, so the
   * search comes back empty-handed and the step lands on the first — the
   * common case, since the reason to press this is that the screen is showing
   * something that does *not* need you.
   */
  const goToNeedy = useCallback(() => {
    const queue = needingNow.current;
    if (queue.length === 0) {
      showFlash('nothing needs you');
      return;
    }
    const here = keyFor(conversationRef.current);
    const at = queue.findIndex((row) => row.key === here);
    const next = queue[(at + 1) % queue.length];
    const target = next === undefined ? undefined : poolRef.current.find((parked) => keyFor(parked) === next.key);
    // The one thing that needs you is the one you are on: the card is already
    // on the screen, and moving nowhere without a word reads as a dead key.
    if (target === undefined || target === conversationRef.current) {
      showFlash('nothing else needs you');
      return;
    }
    switchTo(target);
  }, [keyFor, showFlash, switchTo]);

  /**
   * The pool as the welcome-back line needs to read it.
   *
   * Built at the keystroke rather than kept in a memo: it is wanted once every
   * few minutes at most, and the names come from the rail's own list, which
   * moves for reasons that have nothing to do with this.
   */
  const recapSubjects = useCallback(
    (): readonly RecapSubject[] =>
      poolRef.current.map((parked) => {
        const parkedState = parked.getState();
        const key = keyFor(parked);
        return {
          title: parkedState.sessionId === undefined ? undefined : sessions.find((row) => row.id === parkedState.sessionId)?.title,
          status: parkedState.status,
          pendingPermissions: parkedState.pendingPermissions,
          lastRun: runEnds.current.get(key),
          askedAt: askedAt.current.get(key),
        };
      }),
    [keyFor, sessions],
  );

  /* ---------------------------------------------------------------------- */
  /* The delegated strip, pointed at                                         */
  /* ---------------------------------------------------------------------- */

  /** Which row of the strip the cursor is on. The strip clamps it; see below. */
  const [delegatedSelected, setDelegatedSelected] = useState(0);
  /** Task ids whose workflow agents are unfolded, which `→` and `←` change. */
  const [delegatedExpanded, setDelegatedExpanded] = useState<ReadonlySet<string>>(() => new Set());
  /**
   * The row under the cursor, as the strip reported it.
   *
   * Taken from the strip rather than worked out again here, which is what its
   * header asks for and the reason it hands one back: the rows are read out of
   * the tasks on every render and unfolding changes how many there are, so a
   * second reading in this file would be a second answer to "what does Enter
   * open" — and the two would part company on the first tick of the clock.
   */
  const [delegatedRow, setDelegatedRow] = useState<DelegatedRow | undefined>(undefined);
  /**
   * How many rows the strip has, which is all this file needs of them.
   *
   * Tab must not stop at a strip with nothing in it and ↑↓ must not walk past
   * the end, and both are questions about the count. `delegatedRows` is asked,
   * rather than the tasks counted again, for {@link delegatedRow}'s reason. The
   * clock it is given is only spent on the text of rows nothing here reads.
   */
  const delegatedCount = useMemo(
    () => delegatedRows(state.tasks, Date.now(), mainWidth, { expanded: delegatedExpanded }).rows.length,
    [state.tasks, mainWidth, delegatedExpanded],
  );

  /*
   * A strip that has emptied is a strip nobody can see, and the cursor in it
   * answers keys that now have no rows to act on. The focus comes home.
   */
  useEffect(() => {
    if (delegatedCount === 0 && focus === 'delegated') setFocus('composer');
  }, [delegatedCount, focus]);

  /* ---------------------------------------------------------------------- */
  /* Keys                                                                    */
  /* ---------------------------------------------------------------------- */

  const modalOpen = modal !== null || pendingRequest !== undefined;
  const sidebarActive = focus === 'sidebar' && showSidebar && !modalOpen;
  const delegatedActive = focus === 'delegated' && delegatedCount > 0 && !modalOpen;
  const composerActive = focus === 'composer' && !modalOpen;

  /*
   * The composer's own handle, which is how anything here reaches into the box
   * — and, below, how Esc is asked after rather than taken. See `Composer`.
   */
  const composerRef = useRef<ComposerHandle>(null);

  /*
   * Which prompts ↑ offers, and what Ctrl+R cycles through: this folder first,
   * because "what did I type" nearly always means "here", then everything, and
   * this conversation last — it is the narrowest, and the one someone asks for
   * deliberately rather than by default. `recent` falls through the list until
   * something has entries, so a folder nobody has typed in is not an ↑ that
   * does nothing.
   */
  const historyScopes = useMemo<readonly HistoryScope[]>(
    () => [
      { kind: 'folder', cwd: state.settings.cwd },
      { kind: 'all' },
      ...(state.sessionId === undefined ? [] : [{ kind: 'session', sessionId: state.sessionId } as const]),
    ],
    [state.settings.cwd, state.sessionId],
  );

  /**
   * What `@` completes against: the files under the working directory, and
   * what was picked before.
   *
   * Memoised on the directory, so moving — `/cwd`, or opening a session that
   * ran somewhere else — hands the composer a different index and the listing
   * is taken again. The promise is the cache: a second `@` joins the first
   * listing rather than starting another, and a directory nobody names a file
   * in is never listed at all, because the composer only asks once there is an
   * `@` in the box.
   */
  const fileIndex = useMemo<FileIndex | undefined>(() => {
    if (files === undefined) return undefined;
    const where = state.settings.cwd;
    let listing: Promise<readonly string[]> | undefined;
    return {
      list: () => {
        listing ??= listFiles(where);
        return listing;
      },
      frecency: files,
    };
  }, [files, state.settings.cwd]);

  /**
   * Destroy a conversation, after asking.
   *
   * The transcript file goes and nothing here can bring it back, which is the
   * whole difference from archiving and the reason this is the one rail
   * action that confirms first — with the safe row selected, so Enter pressed
   * once too often does nothing.
   */
  const deleteRailSession = useCallback(
    (session: SessionSummary) => {
      if (host.capabilitiesFor(session.providerId)?.deleteSession !== true) {
        setNotice(`${state.settings.providerLabel} cannot delete a stored conversation.`);
        return;
      }
      confirm(`Delete "${oneLine(session.title, 50)}"? This cannot be undone.`, 'Delete it', true, () => {
        void (async () => {
          try {
            const done = await host.deleteSession(session.profileId, session.providerId, session.id, session.cwd);
            if (!done) {
              setNotice('That conversation could not be deleted; it may already be gone.');
              return;
            }
            // The screen is showing what was just destroyed; there is no
            // conversation left to be in.
            if (session.id === state.sessionId) startNew();
            say('info', `Deleted ${oneLine(session.title, 60)}.`);
            await refreshRail();
          } catch (error) {
            say('error', `Could not delete that conversation: ${describeError(error)}`);
          }
        })();
      });
    },
    [host, state.settings.providerLabel, state.sessionId, confirm, say, refreshRail, startNew],
  );

  const chooseRailRow = useCallback(
    (row: RailRow) => {
      setFocus('composer');
      // The box Space opened is about the row that was under the cursor, and
      // the cursor has just been acted on. The query is left alone: Esc is what
      // takes a filter off, and Enter is not Esc.
      setPreview(null);
      switch (row.kind) {
        case 'new':
          startNew();
          return;
        case 'new-elsewhere':
          openDirectoryPicker();
          return;
        case 'folder':
          setFocus('sidebar');
          setOpenFolders((current) => {
            const next = new Set(current);
            if (next.has(row.project)) next.delete(row.project);
            else next.add(row.project);
            return next;
          });
          return;
        case 'more':
          setFocus('sidebar');
          setExpandedFolders((current) => new Set([...current, row.project]));
          return;
        case 'session': {
          if (row.session.id === state.sessionId) return;
          /*
           * A conversation lives in its account's store and where it ran, so
           * opening one from elsewhere in the rail is opening it on that
           * account, in that directory — as the desktop does. Those go into
           * the conversation being built for it rather than being patched
           * onto the one on screen, which may still be working and is not
           * the one moving.
           */
          const settings: { -readonly [K in keyof ConversationSettings]: ConversationSettings[K] } = {
            ...state.settings,
            cwd: row.session.cwd,
          };
          if (row.session.profileId !== state.settings.profileId) {
            const profile = accounts.find((candidate) => candidate.id === row.session.profileId);
            if (profile === undefined) {
              setNotice('That conversation belongs to an account that is no longer configured.');
              return;
            }
            settings.profileId = profile.id;
            settings.providerId = profile.providerId;
            settings.profileLabel = profile.label;
            settings.providerLabel = descriptors.get(profile.providerId)?.label ?? profile.providerId;
            settings.model = undefined;
            settings.modelLabel = undefined;
            settings.effort = undefined;
            settings.fastMode = undefined;
            settings.ultracode = undefined;
            // The conversation built for it seeds its own plan reading; the
            // one on screen is being left and must not be handed another
            // account's gauge.
            planFetchedAt.current = 0;
          }
          void loadSession(row.session.id, row.session.title, settings);
          return;
        }
        default:
          return;
      }
    },
    [startNew, openDirectoryPicker, state.sessionId, state.settings.cwd, state.settings.profileId, accounts, descriptors, conversation, loadSession],
  );

  /**
   * Go back to an earlier prompt: the list, and what picking one does.
   *
   * Newest first, because "that came out wrong" is why anybody opens this.
   * Every prompt is listed, the ones that cannot be gone back to included —
   * a list with holes in it is a list nobody can account for — and those say
   * why rather than offering a move that would be refused. Nothing is sent
   * here: picking arms the rewind, cuts the screen back to that prompt and
   * puts the words in the box, and the next Enter is what carries the
   * truncation to the provider. See {@link Conversation.armRewind}.
   *
   * A prompt typed in *this* window has no provider id to point at — neither
   * Claude nor Codex echoes a live prompt back on the stream — so its row is
   * greyed with the reason rather than offered. Resolving those by re-reading
   * the stored session and matching the row by its position from the end is
   * what the desktop does, on use rather than up front (see the comment over
   * `UserRow` in `apps/desktop/renderer/src/components/Transcript.tsx`, and
   * `resolveRewindPoint` in `packages/core/src/adapters/history.ts`). That is
   * a provider read, and it is the follow-up to this: nothing here makes one
   * behind a keystroke.
   */
  const openRewindPicker = useCallback(() => {
    const plan = conversation.canRewind();
    if (!plan.ok) {
      showFlash(plan.reason);
      return;
    }
    const turns = [...conversation.userTurns()].reverse();
    if (turns.length === 0) {
      showFlash('Nothing has been sent in this conversation yet.');
      return;
    }
    const items: PickerItem[] = turns.map((turn) => {
      const forThis = turn.messageId === undefined ? undefined : conversation.canRewind(turn.messageId);
      const hint =
        forThis === undefined
          ? 'typed this session'
          : forThis.ok
            ? forThis.fork
              ? 'branch here'
              : 'rewind here'
            : forThis.reason;
      return {
        key: turn.id,
        label: oneLine(turn.text, 70),
        detail: `${formatRelative(turn.ts)} · ${hint}`,
        ...(forThis?.ok === true ? {} : { disabled: true, reason: hint }),
      };
    });
    openPicker({
      title: 'Go back to an earlier prompt',
      items,
      hint: `the screen is cut back now; nothing is sent until you press Enter · ${PICKER_KEYS}`,
      // Cancelling puts back whatever an earlier arm took away. Nothing is
      // armed on the way in, so this is a no-op except for the second
      // opening — arming twice cuts further back, and Esc out of the second
      // list should leave the conversation as the first one left it.
      onCancel: () => {
        conversation.disarmRewind();
      },
      onSelect: (item) => {
        setModal(null);
        const turn = turns.find((candidate) => candidate.id === item.key);
        if (turn?.messageId === undefined) return;
        const armed = conversation.armRewind(turn.messageId);
        if (!armed.ok) {
          setNotice(armed.reason);
          return;
        }
        // The prompt comes back to be edited, which is the whole point of
        // going back to it. `setText` goes in through the editor's own undo,
        // so whatever was in the box is one Ctrl+_ away.
        composerRef.current?.setText(turn.text);
        setFocus('composer');
        setScroll(0);
      },
    });
  }, [conversation, openPicker, showFlash]);

  useInput((input, key) => {
    /*
     * Somebody is here. Every press pushes both bells back out to their full
     * delay — a notification that fires while you are typing is noise, and
     * noise is how a feature like this gets switched off. It is the first
     * thing in the handler because it is true of every key, including the
     * ones a modal below is about to answer.
     *
     * How long they had been gone is read *before* the press is recorded,
     * because the press is what ends the absence. Past three minutes the same
     * keystroke is a return, and a return is owed an account of what happened
     * while nobody was here: see `awayRecap`, which says nothing at all when
     * the answer is nothing. It goes first so that a key with a flash of its
     * own — Ctrl+C, a pin — has the last word on the line, which is right:
     * that one is about what was just pressed.
     */
    const away = attention.current?.idleMs() ?? 0;
    attention.current?.touch();
    if (away >= AWAY_MS) {
      const recap = awayRecap(recapSubjects(), Date.now() - away);
      if (recap !== undefined) showFlash(recap, RECAP_FLASH_MS);
    }

    if (key.ctrl && input === 'c') {
      if (quitArmed.current !== null) {
        clearTimeout(quitArmed.current);
        exit();
        return;
      }
      if (conversation.isLive) void conversation.interrupt();
      showFlash(conversation.isLive ? 'Interrupting · Ctrl+C again to quit' : 'Ctrl+C again to quit');
      quitArmed.current = setTimeout(() => {
        quitArmed.current = null;
      }, QUIT_WINDOW_MS);
      quitArmed.current.unref?.();
      return;
    }

    // Ctrl+T opens and closes the checklist. The composer has no Ctrl+T of
    // its own, so the key reaches here whatever has focus.
    if (key.ctrl && input === 't') {
      setTodoExpanded((open) => !open);
      return;
    }

    /*
     * Ctrl+] goes to the next conversation that needs you.
     *
     * Above the modal guard on purpose, because the commonest reason to press
     * it is that *this* conversation has stopped to ask — and a permission
     * card counts as a modal. Leaving it up over a different conversation is
     * harmless: it is drawn from the state of whichever one is on screen, so
     * it goes with the switch and is waiting again on the way back.
     *
     * A list or the pager is a different matter and is left alone: both are
     * about the conversation being left, and a picker whose subject was
     * swapped underneath it is a picker about nothing. A reverse search is
     * holding the box's text, for the same reason Ctrl+O declines to.
     */
    if (isNextNeedy(input, key)) {
      if (modal !== null) return;
      if (composerActive && composerRef.current?.isCapturing() === true) return;
      goToNeedy();
      return;
    }

    /*
     * Esc belongs to the composer while it is capturing one — its reverse
     * search is open — and to nothing else. Ink has no stop-propagation, so
     * both handlers see the press whatever order they run in; the one that
     * must not act is the one that asks. Interrupting the turn on the Esc that
     * closed a search, or unfollowing the transcript with it, is the bug this
     * is here to prevent.
     */
    if (key.escape && composerActive && composerRef.current?.isCapturing() === true) return;

    if (modal?.kind === 'replay') {
      if (key.escape) setModal(null);
      return;
    }
    if (modalOpen) return;

    /*
     * Ctrl+O unfolds the whole conversation. The pager draws the terminal and
     * answers every key while it is up — the Ctrl+O that closes it included —
     * so nothing below needs to know about it: it is a modal, and `modalOpen`
     * above is what stands the rest of this down. Not out from under a reverse
     * search, which is holding the box's text and would lose it.
     */
    if (key.ctrl && input === 'o') {
      if (composerActive && composerRef.current?.isCapturing() === true) return;
      setModal({ kind: 'pager' });
      return;
    }

    if (key.tab) {
      /*
       * Tab had two owners and this is where they are told apart. While the
       * slash menu or the `@` popup is open the press belongs to the box — it
       * is finishing a word that is already highlighted — and a reverse search
       * owns the keyboard outright. Otherwise Shift+Tab steps the permission
       * mode on, and a bare Tab moves the focus.
       */
      if (composerActive && (composerRef.current?.hasPopup() === true || composerRef.current?.isCapturing() === true)) return;
      if (key.shift) {
        cycleMode();
        return;
      }
      /*
       * Three stops now, two of which come and go — the rail is dropped on a
       * narrow terminal and the strip exists only while something is running —
       * so which ones are there is answered here and which one is next by
       * `nextFocus`, beside the row of the map that promises it.
       */
      setPreview(null);
      setFocus((current) => nextFocus(current, { sidebar: showSidebar, delegated: delegatedCount > 0 }));
      return;
    }

    /*
     * `?` opens the key map. The composer answers it while it has the keys —
     * it is the one that knows the box is empty, and the one that would
     * otherwise insert the character on the same press — so what is left here
     * is the `?` pressed with the focus in the rail.
     */
    if (input === '?' && !composerActive) {
      // The map is the whole pane; a preview left under it would be a second
      // box competing for the rows the map is already using.
      setPreview(null);
      setModal({ kind: 'help' });
      return;
    }
    /*
     * Scrolling the conversation. Arrows, because a laptop has no Page keys
     * and because a terminal on the alternate screen turns the mouse wheel
     * into arrow presses — so the wheel works without mouse reporting. Shift
     * or Ctrl with an arrow moves half a screen; Esc, when nothing is
     * running, follows the end again. The sidebar owns the arrows while it
     * has focus.
     *
     * A *plain* arrow belongs to the composer while the composer has focus: it
     * moves the cursor through what is being typed, and the presses that run
     * off its first and last line come back here as `onArrowOverflow` below,
     * which scrolls exactly as a plain arrow did. A modified arrow and the
     * page keys are never the composer's, so they still move half a screen
     * from wherever focus is.
     *
     * End is the same division: the composer takes it to the end of the line
     * while it has focus — two owners for one key is how the cursor ended up
     * jumping and the transcript snapping to the bottom on a single press —
     * and it follows the end of the conversation only when the composer does
     * not have the keys. Ctrl+End and Ctrl+Home are the composer's own
     * buffer-start and buffer-end, so nothing here answers them.
     */
    if (!sidebarActive && !delegatedActive) {
      const half = Math.max(SCROLL_STEP, Math.floor(scrollExtent.current.viewportLines / 2));
      const bigStep = key.shift || key.ctrl;
      if (key.pageUp || (key.upArrow && (bigStep || !composerActive))) {
        scrollBy(key.pageUp || bigStep ? half : SCROLL_STEP);
        return;
      }
      if (key.pageDown || (key.downArrow && (bigStep || !composerActive))) {
        scrollBy(-(key.pageDown || bigStep ? half : SCROLL_STEP));
        return;
      }
      if ((key.end && !composerActive) || (key.escape && scroll > 0 && !conversation.isLive)) {
        setScroll(0);
        return;
      }
    }

    if (sidebarActive) {
      const row = rail[railIndex];
      const session = row?.kind === 'session' ? row.session : undefined;
      /*
       * Whether the rail is being typed at, which is what decides who owns five
       * of its keys. `j`, `k`, `a`, `d` and `p` are movement and actions at a
       * rail nobody has typed at, and letters of a title the moment somebody
       * has — there is no third reading, and a rail that kept them as shortcuts
       * would be a search box that cannot spell "jump", "and" or "api". The
       * three actions keep working through their Ctrl chords, which are
       * accepted either way so that nothing learned here has to be unlearned.
       */
      const filtering = railQuery.length > 0;

      if (key.escape) {
        // A query is a thing to undo before it is a thing to leave: the first
        // Esc puts the whole list back, which is what somebody who mistyped
        // means by it, and the second leaves the rail.
        setPreview(null);
        if (filtering) setRailFilter('');
        else setFocus('composer');
        return;
      }
      if (key.upArrow || (!filtering && input === 'k')) {
        setRailIndex((i) => (i - 1 + rail.length) % Math.max(1, rail.length));
        return;
      }
      if (key.downArrow || (!filtering && input === 'j')) {
        setRailIndex((i) => (i + 1) % Math.max(1, rail.length));
        return;
      }
      if (key.return) {
        if (row !== undefined) chooseRailRow(row);
        return;
      }
      if (key.backspace || key.delete) {
        setRailFilter((current) => current.slice(0, -1));
        return;
      }
      if (key.ctrl || key.meta) {
        if (session === undefined) return;
        if (input === 'a') void archiveRailSession(session);
        else if (input === 'd') deleteRailSession(session);
        else if (input === 'p') togglePinFor(session.id);
        return;
      }
      if (!filtering && session !== undefined) {
        if (input === 'a') {
          void archiveRailSession(session);
          return;
        }
        if (input === 'd') {
          deleteRailSession(session);
          return;
        }
        if (input === 'p') {
          togglePinFor(session.id);
          return;
        }
      }
      /*
       * Space shows what a conversation is without opening it, and shows it
       * again to put the box away. Only while nothing is typed: under a query
       * it is a space between two words, and a preview that cost somebody the
       * space bar would be a filter that cannot hold a phrase.
       */
      if (!filtering && input === ' ') {
        if (session !== undefined) setPreview((shown) => (shown?.id === session.id ? null : session));
        return;
      }
      /*
       * Anything left that is a character somebody typed is the query. `/` is
       * the one exception, and only at a rail nobody has typed at yet: there it
       * opens an empty query rather than typing itself, so that `/foo` and
       * `foo` reach the same place and the key the legend advertises does what
       * the legend says. Inside a query it is an ordinary character, because a
       * project name is very often `apps/tui`.
       */
      if (!filtering && input === '/') {
        setRailFilter('');
        return;
      }
      if (isTypable(input, key)) setRailFilter((current) => current + input);
      return;
    }

    if (delegatedActive) {
      /*
       * The strip's keys. Every one of them is a lookup on the row the strip
       * reported — `openable`, `stoppable`, the task the row belongs to — and
       * not a second reading of `state.tasks`, which is the arrangement the
       * strip's header asks for and the reason Enter cannot open something the
       * row was not offering.
       */
      if (key.escape) {
        setFocus('composer');
        return;
      }
      if (key.upArrow) {
        setDelegatedSelected((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setDelegatedSelected((i) => Math.min(delegatedCount - 1, i + 1));
        return;
      }
      if (delegatedRow === undefined) return;
      if (key.return) {
        // `openable` is the provider's own filing rather than a wish, so a row
        // that says no is a row with no transcript to open — a backgrounded
        // shell, or a workflow agent that has not been spawned yet.
        const agentId = delegatedRow.agentId;
        if (!delegatedRow.openable || agentId === undefined) {
          showFlash('nothing was filed for that row');
          return;
        }
        void openAgentTranscript(agentId, [delegatedRow.label, delegatedRow.description].filter((part) => part.length > 0).join(' · '));
        return;
      }
      if (input === 'x') {
        // Only ever the task: there is no per-agent stop inside a workflow, and
        // `x` on one agent's row killing the whole workflow is not what anyone
        // pressing it would have meant.
        if (!delegatedRow.stoppable) return;
        showFlash(`stopping ${oneLine(delegatedRow.label, 40)}`);
        void conversation.stopTask(delegatedRow.taskId).then((outcome) => {
          if (!outcome.ok) setNotice(outcome.reason);
        });
        return;
      }
      if (key.rightArrow) {
        if (!delegatedRow.unfoldable) return;
        setDelegatedExpanded((current) => new Set([...current, delegatedRow.taskId]));
        return;
      }
      if (key.leftArrow) {
        // From an agent row too: `←` on one of a workflow's agents folds the
        // workflow it belongs to, which is the row the cursor came from.
        setDelegatedExpanded((current) => {
          if (!current.has(delegatedRow.taskId)) return current;
          const next = new Set(current);
          next.delete(delegatedRow.taskId);
          return next;
        });
        return;
      }
      return;
    }

    if (!key.escape) return;
    if (conversation.isLive) {
      void conversation.interrupt();
      return;
    }

    /*
     * Esc, Esc goes back to an earlier prompt.
     *
     * A chord because the single Esc is spoken for four times over — it
     * interrupts, it leaves the rail, it follows the end of a conversation
     * that was scrolled back, and the composer takes it for its own search —
     * and because the move it opens takes rows off the screen. All four of
     * those have been answered above by the time the press arrives here, so
     * what is left is an Esc at an empty box with nothing running, which
     * means nothing else at all.
     *
     * While a rewind is armed the same key cancels it, from whatever is in
     * the box: the status line is promising exactly that, and the box is not
     * empty at that point — arming put the old prompt in it to be edited.
     */
    if (!composerActive) return;
    if (state.rewindArmed !== undefined) {
      conversation.disarmRewind();
      showFlash('back where you were');
      return;
    }
    if (composerRef.current?.getText() !== '') return;
    if (escArmed.current !== null) {
      clearTimeout(escArmed.current);
      escArmed.current = null;
      openRewindPicker();
      return;
    }
    showFlash('Esc again to go back to an earlier prompt');
    escArmed.current = setTimeout(() => {
      escArmed.current = null;
    }, ESC_ESC_WINDOW_MS);
    escArmed.current.unref?.();
  });

  /* ---------------------------------------------------------------------- */
  /* Layout                                                                  */
  /* ---------------------------------------------------------------------- */

  const tallHeader = rows >= TALL_HEADER_MIN_ROWS;
  const headerRows = tallHeader ? 3 : 2;
  const bodyRows = Math.max(6, rows - headerRows);

  /*
   * The pager is the whole terminal, so it is mounted instead of the layout
   * rather than over it: Ink has no z-index, and a full-screen box drawn as a
   * sibling would push the conversation off the top of the screen instead of
   * covering it. Everything behind it is unmounted, which is the other half of
   * why nothing behind it can answer a key.
   */
  if (modal?.kind === 'pager') {
    return (
      <Pager
        transcript={transcript}
        columns={columns}
        rows={rows}
        onClose={() => setModal(null)}
        /*
         * `v`. The same handover as Ctrl+G — `editExternally` is the only
         * thing in here that may take the terminal — and whatever comes back
         * is dropped: this is a copy to read in an editor, not a draft being
         * written.
         */
        onOpenInEditor={(markdown) => {
          void editExternally(markdown);
        }}
      />
    );
  }

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Header cwd={state.settings.cwd} columns={columns} tall={tallHeader} />

      <Box flexDirection="row" height={bodyRows}>
        {showSidebar && (
          <Sidebar
            rows={rail}
            selected={railIndex}
            focused={sidebarActive}
            {...(state.sessionId === undefined ? {} : { activeSessionId: state.sessionId })}
            activity={railActivity}
            pinned={pinned}
            query={railQuery}
            currentProject={currentProject}
            width={SIDEBAR_WIDTH}
            height={bodyRows}
            loading={railLoading}
          />
        )}

        <Box flexDirection="column" width={mainWidth} height={bodyRows}>
          {/* The pane's width, not the terminal's: what a diff has room for is
              decided on the columns the conversation actually has. */}
          <TranscriptViewport transcript={transcript} live={live} offset={scroll} onExtent={onScrollExtent} columns={mainWidth} />

          {/*
           * Above the card and the pickers rather than directly over the
           * composer, which is where the mockup put it. Those are the surfaces
           * the keys are addressing when they are open, and a readout that
           * nothing can be typed at must not sit between a question and the
           * thing that answers it. With nothing open — the ordinary case —
           * this is the line above the composer either way.
           */}
          <DelegatedStrip
            tasks={state.tasks}
            columns={mainWidth}
            focused={delegatedActive}
            selected={delegatedSelected}
            expanded={delegatedExpanded}
            /*
             * The strip clamps the cursor — its rows move on their own as work
             * settles — and says where it came to rest, so the number held here
             * and the one drawn cannot disagree. The row comes back with it, so
             * Enter and `x` are a lookup rather than a second reading of the
             * tasks.
             */
            onSelect={(row, index) => {
              setDelegatedRow(row);
              if (index >= 0) setDelegatedSelected(index);
            }}
          />

          {/*
           * Between what the agent is doing and what it has not read yet: what
           * it plans. The strip is one line until Ctrl+T opens it, and nothing
           * at all when the list is done or was never written.
           */}
          <TodoStrip transcript={conversation.transcript} expanded={todoExpanded} columns={mainWidth} />

          {/*
           * Under the delegated strip, for the same reason and in the order
           * the two answer: what the agent is doing, then what it has not read
           * yet. Both are given the conversation's width rather than the
           * terminal's — the rail is not theirs to draw over — and both
           * disappear entirely when there is nothing to say, so a conversation
           * that never steers is laid out as it always was.
           */}
          <QueuedStrip messages={state.queuedMessages} columns={mainWidth} />

          {pendingRequest !== undefined && modal === null && (
            <Box paddingX={1} flexShrink={0}>
              <PermissionCard
                key={pendingRequest.id}
                request={pendingRequest}
                /*
                 * A comment typed under the answer travels as an ordinary
                 * message, and only once the decision itself has landed: the
                 * tool call is waiting on the response, and a steer sent
                 * first would be a message the provider has nowhere to put.
                 */
                onDecision={(decision, followUp) => {
                  void conversation.respondToPermission(pendingRequest.id, decision).then(
                    () => {
                      if (followUp !== undefined) submit(followUp);
                    },
                    () => undefined,
                  );
                }}
              />
            </Box>
          )}
          {modal?.kind === 'loading' && (
            <Box paddingX={1} flexShrink={0}>
              <Box borderStyle="round" borderDimColor paddingX={1}>
                <Text dimColor>{modal.title}</Text>
              </Box>
            </Box>
          )}
          {modal?.kind === 'picker' && (
            <Box paddingX={1} flexShrink={0}>
              <Picker
                /*
                 * Keyed by title, so that a picker showing a *different*
                 * list starts at the top of it. The folder browser replaces
                 * its rows on every step, and a cursor kept from the last
                 * directory can sit past the end of a smaller one — a
                 * selection you cannot see and an Enter that does nothing. A
                 * picker refreshed in place keeps its title, and so keeps
                 * its cursor, which is the case this must not disturb.
                 */
                key={modal.title}
                title={modal.title}
                items={modal.items}
                {...(modal.initialKey === undefined ? {} : { initialKey: modal.initialKey })}
                {...(modal.hint === undefined ? {} : { hint: modal.hint })}
                onSelect={modal.onSelect}
                {...(preview === null
                  ? {}
                  : { maxRows: Math.max(3, Math.min(PICKER_ROWS_WITH_PREVIEW, bodyRows - PREVIEW_SLOT_ROWS)) })}
                {...(modal.filterable === true ? { filterable: true } : {})}
                {...(modal.onPreview === undefined ? {} : { onPreview: modal.onPreview })}
                {...(modal.onRename === undefined ? {} : { onRename: modal.onRename })}
                {...(modal.onSecondary === undefined ? {} : { onSecondary: modal.onSecondary })}
                onCancel={() => {
                  setModal(null);
                  modal.onCancel?.();
                }}
              />
            </Box>
          )}
          {modal?.kind === 'prompt' && (
            <Box paddingX={1} flexShrink={0}>
              <Prompt
                title={modal.title}
                initial={modal.initial}
                placeholder="a name for this conversation"
                onSubmit={modal.onSubmit}
                onCancel={modal.onCancel}
              />
            </Box>
          )}
          {/*
           * Under whatever opened it. Space in the rail and Space in the
           * conversation list put the same box in the same place — see the
           * note on `preview` for why that place is here and not inside the
           * thirty-two columns of the rail.
           */}
          {preview !== null && (
            <Box paddingX={1} flexShrink={0}>
              <SessionPreview session={preview} columns={mainWidth - 2} />
            </Box>
          )}
          {modal?.kind === 'help' && (
            <Box paddingX={1} flexShrink={0}>
              {/* Sized to the pane it sits in rather than the screen, like
                  everything else in this column; the overlay decides for
                  itself whether that is wide enough for two columns of keys. */}
              <Help columns={mainWidth - 2} rows={Math.max(8, bodyRows - 8)} onClose={() => setModal(null)} />
            </Box>
          )}
          {modal?.kind === 'text' && (
            <Box paddingX={1} flexShrink={0}>
              {/* Sized to the pane, like everything else in this column. The
                  lines were built to the same width when the command ran —
                  see `TextModal` — so this is a fit and not a reflow. */}
              <TextView
                title={modal.title}
                lines={modal.lines}
                columns={mainWidth - 2}
                rows={Math.max(8, bodyRows - 8)}
                onClose={() => setModal(null)}
              />
            </Box>
          )}
          {modal?.kind === 'replay' && (
            <Box paddingX={1} flexShrink={0}>
              <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1}>
                <Text color={ACCENT} bold>
                  Agent · {modal.title}
                </Text>
                <ReplayRows events={modal.events} maxRows={Math.max(6, bodyRows - 8)} columns={mainWidth} />
                <Text dimColor>Esc closes</Text>
              </Box>
            </Box>
          )}

          <Box flexDirection="column" flexShrink={0} paddingX={1}>
            <Composer
              ref={composerRef}
              onSubmit={submit}
              live={live}
              locked={locked}
              isActive={composerActive}
              attachments={pendingAttachments.map((entry) => entry.name)}
              providerCommands={state.slashCommands}
              history={history}
              historyScopes={historyScopes}
              {...(fileIndex === undefined ? {} : { fileIndex })}
              /*
               * ↑ on an empty box. The composer knows it is empty and the
               * conversation knows whether anything is waiting, so the
               * composer asks and this answers: the words of the newest
               * queued message, or nothing at all, which leaves ↑ to the
               * history. Taking it back here is what the strip's header
               * promises — see `Conversation.takeBackQueued`.
               */
              onTakeBackQueued={() => conversation.takeBackQueued()}
              // An arrow the text and the history both had no use for — ↑ on
              // the first line with nothing left to recall, ↓ on the last —
              // scrolls the conversation, which is what a plain arrow has
              // always done here.
              onArrowOverflow={(direction) => {
                scrollBy(direction === 'up' ? SCROLL_STEP : -SCROLL_STEP);
              }}
              // Ctrl+G and `!`. Both leave the composer knowing nothing about
              // a terminal or a child process: one is a promise of text, the
              // other a command and a flag.
              onExternalEdit={editExternally}
              onShell={runShellLine}
              // `?` at an empty box. The composer owns the key — it is what
              // knows the box is empty, and what would otherwise put the
              // character in it — and this is what the key opens.
              onHelp={() => setModal({ kind: 'help' })}
              {...(notice === undefined ? {} : { notice })}
            />
            <StatusBar
              state={state}
              columns={mainWidth}
              needing={needing.length}
              {...(flash === undefined ? {} : { flash })}
              {...(update === undefined ? {} : { update })}
              /*
               * An armed rewind outranks the other two: it is a state the next
               * Enter behaves differently in, and the only place a person is
               * told that the message they are about to send will land
               * somewhere other than the end of the conversation.
               */
              {...(state.rewindArmed !== undefined
                ? {
                    hint: `${state.rewindArmed.fork ? 'branching from' : 'rewinding to'} an earlier prompt · Esc cancels`,
                  }
                : sidebarActive
                  ? railQuery.length > 0
                    ? // The rail's own legend has the room for three chords and
                      // no more; this is where the words for them go.
                      { hint: 'filtering: Ctrl+A archive · Ctrl+D delete · Ctrl+P pin · Esc clears' }
                    : { hint: 'sidebar: ↑↓ Enter · a archive · d delete · p pin · Space preview · / filter' }
                  : scroll > 0
                    ? { hint: 'scrolled · Esc to follow' }
                    : {})}
            />
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
