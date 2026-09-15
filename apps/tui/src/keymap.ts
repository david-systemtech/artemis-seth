/**
 * Every key the terminal answers, written down once.
 *
 * Until now the bindings lived where they were handled: Ctrl+W in a switch in
 * the composer, `a` and `d` in a branch of app.tsx, `{` and `}` in the pager,
 * and the rest in the prose at the head of each of those files. That is the
 * right place to *implement* a key and the worst place to *find* one. Nobody
 * reads five module headers to learn what Ctrl+Y does, so in practice the keys
 * that were not on a hint line did not exist.
 *
 * So the map is data, here, and the overlay (`components/Help.tsx`) is the only
 * thing that draws it. Adding a binding and telling someone about it become one
 * edit instead of two, and the second one is the one that always got skipped.
 *
 * ## One key, one row, per context
 *
 * A row is a key and what it does *in a place* — the composer, the sidebar, a
 * permission card, the pager, or anywhere at all. Within one context a key
 * appears exactly once, which is a claim the tests check: two rows for one key
 * in one place would mean either the map is lying or two handlers are fighting
 * over a keystroke, and both are worth failing a build over.
 *
 * That rule is why some rows read as two sentences. Enter in the composer sends
 * the message, steers a running turn, runs the highlighted row of the slash
 * menu, takes the highlighted path of an `@` popup, and sends the match found
 * by Ctrl+R — five things, but never two at once, because each belongs to a
 * mode that suspends the others. Folding them into one row is what makes "what
 * does Enter do here" a question with an answer.
 *
 * Contexts are not exclusive of one another, and deliberately: Tab is in
 * `anywhere` because it moves the focus and in `composer` because it also
 * completes what is being typed. Both are true, on the same press.
 *
 * ## Keys that are decided but not yet wired
 *
 * `planned` rows are bindings the design has settled and the code has not
 * caught up with. They are in the map rather than waiting outside it because
 * the alternative — remembering to add them later — is how a keymap and a
 * codebase drift apart. The overlay dims them and writes `(soon)` after them,
 * so nobody presses one and concludes the app is broken.
 *
 * The slash commands come last, built from {@link COMMANDS} rather than
 * retyped, so the overlay is the whole map and not the keyboard half of it.
 *
 * ## Where Tab goes
 *
 * One key in the map is not a description of behaviour but the behaviour
 * itself: {@link nextFocus} is the ring Tab walks. It is here rather than in
 * `app.tsx` for the reason the rest of this file exists — the row that says
 * "Tab: round the composer, the list and the strip" and the code that makes
 * that true are one edit apart, so the map cannot go on promising a stop the
 * ring has dropped.
 */

import { COMMANDS } from './commands.js';

/**
 * Where a key means what it means.
 *
 * `anywhere` is the handful that no component may take: the focus switch, the
 * interrupt, the quit. The rest name whatever has the keyboard at the time.
 */
export type KeyContext =
  | 'composer'
  | 'transcript'
  | 'sidebar'
  | 'delegated'
  | 'picker'
  | 'permission'
  | 'pager'
  | 'anywhere';

/** The three places the keyboard can be, in the order Tab walks them. */
export type Focus = 'composer' | 'sidebar' | 'delegated';

/** Which stops on the ring exist right now. The composer is always one. */
export interface FocusStops {
  /** False on a terminal too narrow for the rail, which is then not drawn. */
  readonly sidebar: boolean;
  /** False whenever nothing is delegated; the strip is not drawn either. */
  readonly delegated: boolean;
}

/**
 * The next stop after `current`, skipping the ones that are not there.
 *
 * A ring rather than a toggle, because there are three stops now and two of
 * them come and go: the rail disappears on a narrow terminal and the delegated
 * strip exists only while something is running. Tab must therefore never land
 * on a surface that is not on the screen — a cursor nobody can see, answering
 * keys nobody can account for — and must always be able to get back to the
 * composer, which is the one stop that is always there. Both of those are what
 * make this worth a function and a test rather than a chain of ternaries at the
 * keystroke.
 */
export function nextFocus(current: Focus, stops: FocusStops): Focus {
  const ring: Focus[] = ['composer'];
  if (stops.sidebar) ring.push('sidebar');
  if (stops.delegated) ring.push('delegated');
  // A focus whose stop has just gone — the last task settled while the strip
  // had the keys — is not on the ring, so `indexOf` is -1 and the step lands on
  // the composer. Tab always leads out of a surface that is no longer there.
  const at = ring.indexOf(current);
  return ring[(at + 1) % ring.length] ?? 'composer';
}

export interface KeyBinding {
  /** The presses that do it. Several here are alternatives, not a chord. */
  readonly keys: readonly string[];
  /** What happens, as a person would say it. Short: this sits in a column. */
  readonly does: string;
  /** Decided, not yet wired. Drawn dimmer, with `(soon)` after it. */
  readonly planned?: boolean;
}

export interface KeyGroup {
  readonly title: string;
  readonly context: KeyContext;
  readonly keys: readonly KeyBinding[];
}

/** The title of the group built from {@link COMMANDS}; the tests look it up. */
export const SLASH_GROUP_TITLE = 'Slash commands';

/**
 * The keyboard, in the order it is worth learning: what always works, then the
 * box you spend the day in, then the places you visit.
 */
const GROUPS: readonly KeyGroup[] = [
  {
    title: 'Anywhere',
    context: 'anywhere',
    keys: [
      { keys: ['Tab'], does: 'Round the composer, the list and the strip' },
      { keys: ['Shift+Tab'], does: 'Step the permission mode on' },
      { keys: ['Esc'], does: 'Interrupt; or follow the end again' },
      { keys: ['Esc Esc'], does: 'Go back to an earlier prompt' },
      { keys: ['Ctrl+C'], does: 'Interrupt; again in a moment to quit' },
      { keys: ['Ctrl+O'], does: 'Unfold the whole transcript' },
      { keys: ['Ctrl+T'], does: 'Show or hide the checklist' },
      { keys: ['?'], does: 'Open this map, from an empty composer' },
    ],
  },
  {
    title: 'Writing a message',
    context: 'composer',
    keys: [
      { keys: ['Enter'], does: 'Send it, steer a turn, run a row' },
      { keys: ['Shift+Enter', 'Ctrl+J'], does: 'A newline instead of sending' },
      { keys: ['\\ Enter'], does: 'A backslash keeps the line open' },
      { keys: ['↑', '↓'], does: 'The text, then the queue, then history' },
      { keys: ['/'], does: 'Start a command, and see the menu' },
      { keys: ['@'], does: 'Name a file, and see the paths' },
      { keys: ['Tab'], does: 'Fill in the highlighted row' },
      { keys: ['!'], does: 'Run a shell command; !! sends the output' },
      { keys: ['Ctrl+V'], does: 'Paste an image, or the text there' },
      { keys: ['Ctrl+G'], does: 'Edit the draft in $EDITOR' },
    ],
  },
  {
    title: 'Moving and editing',
    context: 'composer',
    keys: [
      { keys: ['Ctrl+A', 'Home'], does: 'The start of the line' },
      { keys: ['Ctrl+E', 'End'], does: 'The end of it' },
      { keys: ['Ctrl+Home'], does: 'The start of everything typed' },
      { keys: ['Ctrl+End'], does: 'The end of everything typed' },
      { keys: ['Alt+B', 'Ctrl+←'], does: 'A word back' },
      { keys: ['Alt+F', 'Ctrl+→'], does: 'A word on' },
      { keys: ['Ctrl+W'], does: 'Rub out the word before the cursor' },
      { keys: ['Alt+D'], does: 'Delete the word after it' },
      { keys: ['Ctrl+U'], does: 'Cut back to the start of the line' },
      { keys: ['Ctrl+K'], does: 'Cut on to the end of it' },
      { keys: ['Ctrl+Y'], does: 'Put back the last thing cut' },
      { keys: ['Ctrl+_'], does: 'Undo' },
      { keys: ['Backspace'], does: 'A whole paste chip; or the search query' },
    ],
  },
  {
    title: 'What you typed before',
    context: 'composer',
    keys: [
      { keys: ['Ctrl+R'], does: 'Search back through past prompts' },
      { keys: ['Ctrl+S'], does: 'What the search looks at; outside one, stash the draft' },
    ],
  },
  {
    title: 'The conversation',
    context: 'transcript',
    keys: [
      { keys: ['PgUp', 'Shift+↑', 'Ctrl+↑'], does: 'Half a screen back' },
      { keys: ['PgDn', 'Shift+↓', 'Ctrl+↓'], does: 'Half a screen on' },
      { keys: ['↑', '↓'], does: 'A line, with focus off the composer' },
      { keys: ['End'], does: 'Back to the end, and follow it' },
    ],
  },
  {
    title: 'The conversation list',
    context: 'sidebar',
    keys: [
      { keys: ['↑', '↓'], does: 'Move the cursor' },
      { keys: ['k', 'j'], does: 'The same — until a filter is being typed' },
      { keys: ['Enter'], does: 'Open it, or fold the folder' },
      { keys: ['/'], does: 'Filter the list by what you type' },
      { keys: ['Backspace'], does: 'Rub a letter off the filter' },
      { keys: ['Space'], does: 'Show what a conversation is, unopened' },
      { keys: ['a'], does: 'Archive the one under the cursor' },
      { keys: ['d'], does: 'Delete it' },
      { keys: ['p'], does: 'Pin it to the top of its folder' },
      { keys: ['Ctrl+A'], does: 'Archive it, while a filter is being typed' },
      { keys: ['Ctrl+D'], does: 'Delete it, while filtering' },
      { keys: ['Ctrl+P'], does: 'Pin it, while filtering' },
      { keys: ['Esc'], does: 'Clear the filter; then back to the composer' },
    ],
  },
  {
    title: 'Delegated work',
    context: 'delegated',
    keys: [
      { keys: ['Tab'], does: 'Reached after the list, while work is running' },
      { keys: ['↑', '↓'], does: 'Move down the strip' },
      { keys: ['Enter'], does: 'Open what that agent did' },
      { keys: ['x'], does: 'Stop the task under the cursor' },
      { keys: ['→'], does: "Unfold a workflow's agents" },
      { keys: ['←'], does: 'Fold them again' },
      { keys: ['Esc'], does: 'Back to the composer' },
    ],
  },
  {
    title: 'A list to choose from',
    context: 'picker',
    keys: [
      { keys: ['↑', '↓'], does: 'Move the cursor' },
      { keys: ['k', 'j'], does: 'The same, in a list that is not typed at' },
      { keys: ['Letters'], does: 'Type to filter a long list' },
      { keys: ['Enter'], does: 'Choose the row under the cursor' },
      { keys: ['Space'], does: 'Preview it without opening it' },
      { keys: ['Ctrl+R'], does: 'Rename the conversation under the cursor' },
      { keys: ['Ctrl+A'], does: 'Archive it' },
      { keys: ['Ctrl+P'], does: 'Pin it' },
      { keys: ['Esc'], does: 'Clear the query; then close the list' },
    ],
  },
  {
    title: 'A permission card',
    context: 'permission',
    keys: [
      { keys: ['↑', '↓', 'k', 'j'], does: 'Move down the answers' },
      { keys: ['Enter'], does: 'Choose the one under the cursor' },
      { keys: ['Esc'], does: 'Deny it; on a question, skip it' },
      { keys: ['Tab'], does: 'A line: why, or what to do after' },
      { keys: ['e'], does: 'Edit the rule that row would save' },
      { keys: ['s'], does: 'Walk the scope it is saved at' },
      { keys: ['Space'], does: 'Tick one of several options' },
    ],
  },
  {
    title: 'The whole transcript',
    context: 'pager',
    keys: [
      { keys: ['j', 'k', '↑', '↓'], does: 'A line' },
      { keys: ['Space'], does: 'A screen on' },
      { keys: ['b'], does: 'A screen back' },
      { keys: ['PgDn', 'Ctrl+D'], does: 'Half a screen on' },
      { keys: ['PgUp', 'Ctrl+U'], does: 'Half a screen back' },
      { keys: ['g', 'Home'], does: 'The top' },
      { keys: ['G', 'End'], does: 'The bottom' },
      { keys: ['}'], does: 'The next turn' },
      { keys: ['{'], does: 'The turn before' },
      { keys: ['/'], does: 'Search the whole conversation' },
      { keys: ['n', 'N'], does: 'The next match, the one before' },
      { keys: ['v'], does: 'Open the conversation in your editor' },
      { keys: ['q', 'Esc'], does: 'Close it' },
    ],
  },
];

/**
 * The commands, echoed from {@link COMMANDS} rather than written out again.
 *
 * They are keys in the sense that matters here — things you type to make the
 * TUI do something — and leaving them out would mean two places to look, which
 * is the thing this module exists to end.
 */
const SLASH_GROUP: KeyGroup = {
  title: SLASH_GROUP_TITLE,
  context: 'composer',
  keys: COMMANDS.map((command) => ({ keys: [command.usage], does: command.summary })),
};

export const KEYMAP: readonly KeyGroup[] = [...GROUPS, SLASH_GROUP];
