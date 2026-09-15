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
 * Two things in the map are not descriptions of behaviour but the behaviour
 * itself: {@link nextFocus} is the ring Tab walks, and {@link stepCursor} is
 * what ↑ and ↓ do to the cursor once that ring has reached the transcript.
 * Both are here rather than in `app.tsx` for the reason the rest of this file
 * exists — the row that says "Tab: round the composer, the list, the strip and
 * the conversation" and the code that makes it true are one edit apart, so the
 * map cannot go on promising a stop the ring has dropped.
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

/** The four places the keyboard can be, in the order Tab walks them. */
export type Focus = 'composer' | 'sidebar' | 'delegated' | 'transcript';

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
 * A ring rather than a toggle, because there are four stops now and two of
 * them come and go: the rail disappears on a narrow terminal and the delegated
 * strip exists only while something is running. Tab must therefore never land
 * on a surface that is not on the screen — a cursor nobody can see, answering
 * keys nobody can account for — and must always be able to get back to the
 * composer, which is the one stop that is always there. Both of those are what
 * make this worth a function and a test rather than a chain of ternaries at the
 * keystroke.
 *
 * The conversation is last, and it has no flag: it is the one surface that is
 * always drawn, and a transcript with nothing in it is a stop whose only keys
 * are Esc and the arrows that find no row — which is a dead end somebody can
 * see, rather than one Tab quietly skipped. It comes after the strip because
 * the order of the ring is the order of the screen read bottom-up: the box you
 * type in, the list beside it, the work above it, then what was said.
 */
export function nextFocus(current: Focus, stops: FocusStops): Focus {
  const ring: Focus[] = ['composer'];
  if (stops.sidebar) ring.push('sidebar');
  if (stops.delegated) ring.push('delegated');
  ring.push('transcript');
  // A focus whose stop has just gone — the last task settled while the strip
  // had the keys — is not on the ring, so `indexOf` is -1 and the step lands on
  // the composer. Tab always leads out of a surface that is no longer there.
  const at = ring.indexOf(current);
  return ring[(at + 1) % ring.length] ?? 'composer';
}

/**
 * Where ↑ or ↓ takes the transcript's cursor, given the rows on screen.
 *
 * Clamped rather than wrapped, which is the opposite of what the rail does and
 * deliberately: the rail is a list of a few dozen rows somebody is hunting
 * through, and a conversation is a thing with a beginning and an end that the
 * reader has a mental picture of. A cursor that leapt from the last row to the
 * first would be the transcript folding round on itself.
 *
 * A cursor that is nowhere — `null`, or on a row the window no longer draws —
 * lands on the *last* row whichever arrow was pressed. That is where the eye
 * already is: the viewport is anchored to the bottom, so arriving in the
 * conversation means arriving at the end of it.
 *
 * `null` back only when there are no rows at all, which is an empty
 * conversation and nothing to point at.
 */
export function stepCursor(rows: readonly string[], current: string | null, delta: number): string | null {
  if (rows.length === 0) return null;
  const at = current === null ? -1 : rows.indexOf(current);
  if (at === -1) return rows[rows.length - 1] ?? null;
  return rows[Math.max(0, Math.min(rows.length - 1, at + delta))] ?? null;
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
      { keys: ['Tab'], does: 'Round the composer, the list, the strip and the rows' },
      { keys: ['Shift+Tab'], does: 'Step the permission mode on' },
      { keys: ['Esc'], does: 'Interrupt; or follow the end again' },
      { keys: ['Esc Esc'], does: 'Go back to an earlier prompt' },
      { keys: ['Ctrl+C'], does: 'Interrupt; again in a moment to quit' },
      { keys: ['Ctrl+O'], does: 'Unfold the whole transcript' },
      { keys: ['Ctrl+T'], does: 'Show or hide the checklist' },
      { keys: ['Ctrl+]'], does: 'Go to the next conversation that needs you' },
      /*
       * The offer, when the plan has run out. The row exists whether or not
       * the line under the composer is showing one: a key nobody can find
       * until the moment they are already stuck is a key nobody presses.
       *
       * Alt and not Ctrl, which is what this was first bound to. Ctrl+H sends
       * the bare C0 byte `\x08` on any terminal that has not negotiated the
       * kitty keyboard protocol, and Ink reports that as `backspace` — the
       * same thing the Backspace key sends. A key the app cannot tell from a
       * rub-out is a key that either does nothing or eats the rub-out, and
       * neither is a binding worth keeping. `/handoff` is the door for a
       * terminal that eats Alt as well.
       */
      { keys: ['Alt+H'], does: 'Hand this conversation to another account' },
      { keys: ['?'], does: 'Open this map, from an empty composer' },
    ],
  },
  {
    title: 'Writing a message',
    context: 'composer',
    keys: [
      /*
       * The fourth thing Enter does at the box, and the one that needs saying:
       * with a failed check on offer and nothing typed, it sends that failure
       * to the agent. One row rather than two, because the rule here is one
       * key one row per context, and because they are never true at once —
       * with words in the box Enter sends the words.
       */
      { keys: ['Enter'], does: 'Send it, steer a turn, run a row, send a failed check' },
      { keys: ['Shift+Enter', 'Ctrl+J'], does: 'A newline instead of sending' },
      { keys: ['\\ Enter'], does: 'A backslash keeps the line open' },
      { keys: ['↑', '↓'], does: 'The text, then the queue, then history' },
      { keys: ['/'], does: 'Start a command, and see the menu' },
      { keys: ['@'], does: 'Name a file, and see the paths' },
      /*
       * The third sigil, and the only one that is two characters. It is on the
       * map next to `/` and `@` because that is what it is — a trigger that
       * offers a list under the box — and because a saved prompt nobody can
       * find the trigger for is a notes file with extra steps.
       */
      { keys: [';;'], does: 'Expand a saved snippet; Tab walks its slots' },
      // Two things, one row, for the reason Ctrl+S has one: a row naming only
      // the completion would be the map quietly lying about the other.
      { keys: ['Tab'], does: 'Fill in the highlighted row, or the next slot' },
      /*
       * The one key whose meaning here is not the meaning it has in `anywhere`.
       * While a template's holes are still open the composer owns Tab and
       * Shift+Tab both, and the app's mode switch stands down — see the note on
       * the Tab branch in `app.tsx`. Two rows in two contexts rather than one,
       * because they are two different keys to the person pressing them.
       */
      { keys: ['Shift+Tab'], does: 'Back to the slot before, in a snippet' },
      { keys: ['!'], does: 'Run a shell command; !! sends the output' },
      { keys: ['Ctrl+V'], does: 'Paste an image, or the text there' },
      { keys: ['Ctrl+G'], does: 'Edit the draft in $EDITOR' },
      /*
       * The chips under an answer wear these numbers, and this is the other
       * half of that: a number drawn on a chip has to name a key, or it is
       * decoration. Only while the box is empty and only on the newest answer's
       * offers — see `suggestions.ts` — so the digits are ordinary characters
       * the rest of the time.
       */
      { keys: ['1–4'], does: 'Take one of the follow-ups the agent offered' },
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
      { keys: ['↑', '↓'], does: 'The cursor’s row here; a line, from the box' },
      { keys: ['End'], does: 'Back to the end, and follow it' },
    ],
  },
  /*
   * What a row answers to once Tab has reached the conversation. Every one of
   * these is offered by `rowVerbs.ts` per row and printed under the cursor as
   * it moves, so this group is the *whole* set and no row shows all of it: `o`
   * needs a file, `r` needs a command, `d` needs a diff, `x` needs something
   * still running. The hint under the cursor is what says which of them this
   * row has.
   */
  {
    title: 'A row of the conversation',
    context: 'transcript',
    keys: [
      { keys: ['o'], does: 'Open the file it touched, at the line' },
      { keys: ['r'], does: 'Put the command it ran back in the composer' },
      { keys: ['y'], does: 'Copy the row — a diff as a diff' },
      { keys: ['d'], does: 'The whole diff it wrote' },
      { keys: ['Enter'], does: 'Unfold what the row is holding back' },
      { keys: ['x'], does: 'Stop the call that is still running' },
      { keys: ['Esc'], does: 'Put the cursor away, back to the composer' },
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
