/**
 * What the terminal says about Artemis while you are looking somewhere else.
 * ============================================================================
 *
 * Artemis is the one agent terminal where several conversations are parked and
 * working at the same time. That makes the window's own chrome — its title, the
 * taskbar light behind it, and the bell — load-bearing rather than decorative:
 * they are the only channel Artemis has to a person who has tabbed away. Every
 * other agent terminal already uses it. Gemini writes a state glyph and a word
 * into the title; Claude Code rings when a turn ends or a permission is
 * waiting, but only if you are not already typing. This module is all three of
 * those, and none of the policy about when they happen — the app decides that
 * and calls in.
 *
 * Decisions worth knowing:
 *
 *  - **Nothing here throws, and nothing here is unsafe off a terminal.** Every
 *    write goes through one guard that requires a TTY and swallows the write's
 *    own failure, because the caller is a state change in the UI and there is
 *    no sensible thing for it to do about a closed pipe. Piping Artemis into a
 *    file must not put escape bytes in the file.
 *  - **The title is a fixed 80 columns, padded.** A taskbar button and a
 *    terminal tab are sized from the title, so a title that changes length
 *    every frame makes the button jitter and, on a proportional font, makes
 *    every neighbouring tab twitch with it. Gemini pads to 80 for exactly this
 *    reason and so does this. Width is counted in code points, not display
 *    cells: a wcwidth table for a cosmetic pad is not worth the weight, and the
 *    error is a column or two on a CJK conversation name.
 *  - **The conversation name is what gets cut, not the state.** The three
 *    things in a title are worth different amounts: the state word is the whole
 *    point, the folder says which of several Artemis windows this is, and the
 *    conversation name is the part that can be a paragraph. So the folder gets
 *    a fixed budget and keeps its tail (the end of a path is what identifies
 *    it), the state is never touched, and the name absorbs the whole overflow.
 *  - **Sequences are chosen by what the terminal is, never by what it claims.**
 *    None of these escapes can be asked about, and a terminal that does not know
 *    OSC 9;4 will happily print it as garbage across the prompt. So the taskbar
 *    and notification routes are allow-lists keyed on the environment variables
 *    a terminal sets for itself, and anything unrecognised gets the one
 *    sequence that has been safe since the teletype — or nothing at all.
 *  - **Inside tmux an escape belongs to tmux** until it is wrapped in a DCS
 *    passthrough, which requires doubling every escape byte inside it. The bell
 *    is the deliberate exception: tmux handles a bell itself (the window flag,
 *    the visual bell, `bell-action`), and wrapping one would take that away to
 *    hand the outer terminal a beep it cannot attribute to a pane.
 *  - **The bell waits for you to stop typing.** `AttentionTimer` is the idle
 *    rule Claude Code documents: a permission prompt rings after roughly six
 *    seconds of no keystroke, a finished turn after roughly sixty, and every
 *    keystroke pushes both back. The point is not to ring at someone who is
 *    already watching the screen — a notification that fires while you are
 *    mid-sentence is noise, and noise gets the whole feature switched off.
 *  - **Two switches, both opt-out.** `ARTEMIS_TUI_NO_TITLE=1` silences the
 *    window chrome — title *and* taskbar, because they are one feature to the
 *    person turning them off and a taskbar still flashing after the title went
 *    quiet reads as a bug. `ARTEMIS_TUI_NOTIFY=off` silences the bell, and may
 *    instead name a method outright for when the guess is wrong — which it will
 *    be over SSH, where none of the identifying variables survive the hop.
 *  - **Everything a test would have to own is a parameter**: the environment,
 *    the output stream, the platform and the clock. The suite asserts exact
 *    bytes for every terminal, on a machine that is none of them.
 */

// ---------------------------------------------------------------------------
// What this module needs from the world
// ---------------------------------------------------------------------------

/**
 * The part of `process.stdout` an escape sequence needs. Declared here rather
 * than shared with `clipboard.ts`: both are satisfied by `process.stdout`, and
 * neither module should have to be built in order to use the other.
 */
export interface TerminalStdout {
  write(chunk: string): unknown;
  /** Escape bytes written to something that is not a terminal are just bytes in a file. */
  readonly isTTY?: boolean;
}

export interface TerminalDeps {
  readonly env?: NodeJS.ProcessEnv;
  /** Where every sequence is written. `process.stdout` by default. */
  readonly stdout?: TerminalStdout;
  /** `process.platform`, or what a test says it is. */
  readonly platform?: string;
}

interface Wired {
  readonly env: NodeJS.ProcessEnv;
  readonly stdout: TerminalStdout | undefined;
  readonly platform: string;
}

function wire(deps: TerminalDeps): Wired {
  return {
    env: deps.env ?? process.env,
    stdout: deps.stdout ?? process.stdout,
    platform: deps.platform ?? process.platform,
  };
}

const ESC = '\u001b';
const BEL = '\u0007';

/** An OSC sequence, BEL-terminated: every terminal here accepts BEL; not all accept ST. */
const osc = (body: string): string => `${ESC}]${body}${BEL}`;

/**
 * The DCS passthrough tmux needs in order to forward a sequence to the real
 * terminal. Every escape byte inside has to be doubled, which for a
 * single-escape OSC is the familiar `ESC P tmux ; ESC <seq> ESC \` shape.
 */
const tmuxWrap = (sequence: string): string => `${ESC}Ptmux;${sequence.replaceAll(ESC, ESC + ESC)}${ESC}\\`;

const present = (value: string | undefined): boolean => value !== undefined && value.length > 0;

const inTmux = (deps: Wired): boolean => present(deps.env['TMUX']);

const forTerminal = (deps: Wired, sequence: string): string => (inTmux(deps) ? tmuxWrap(sequence) : sequence);

/**
 * The single write. A missing stream, a stream that is not a terminal and a
 * stream that fails mid-write are all `false` — the one thing every caller here
 * would do about any of them is nothing.
 */
function emit(deps: Wired, bytes: string): boolean {
  const stdout = deps.stdout;
  if (stdout === undefined || stdout.isTTY !== true) return false;
  try {
    stdout.write(bytes);
    return true;
  } catch {
    return false;
  }
}

/** Whether the window chrome — title and taskbar both — has been switched off. */
const chromeMuted = (deps: Wired): boolean => (deps.env['ARTEMIS_TUI_NO_TITLE'] ?? '') === '1';

// ---------------------------------------------------------------------------
// Text that has to survive being inside an escape sequence
// ---------------------------------------------------------------------------

/** C0 and C1 controls. A conversation name is model output; it can contain anything. */
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/gu;

/** Code points, not UTF-16 units, so a cut never lands inside a surrogate pair. */
const points = (value: string): readonly string[] => Array.from(value);

const cut = (value: string, limit: number): string => {
  const glyphs = points(value);
  return glyphs.length <= limit ? value : glyphs.slice(0, Math.max(0, limit)).join('');
};

/**
 * The least that has to be done to any text going into a sequence: an embedded
 * BEL or ESC would end that sequence early and spray the rest across the
 * shell's prompt, so every control becomes a space. Whitespace is otherwise
 * left exactly as it was — the title's padding *is* whitespace, and collapsing
 * it would undo the one thing the padding is for.
 */
const safe = (value: string, limit: number): string => cut(value.replace(CONTROLS, ' '), limit);

/** One line, for text that is being composed rather than passed through. */
const plain = (value: string, limit: number): string => cut(safe(value, limit * 4).replace(/\s+/gu, ' ').trim(), limit);

/** Shortened from the right, where a sentence keeps its least important words. */
const headEllipsis = (value: string, limit: number): string => (points(value).length <= limit ? value : `${cut(value, Math.max(0, limit - 1))}…`);

/** Shortened from the left: the end of a path is the part that names it. */
const tailEllipsis = (value: string, limit: number): string => {
  const glyphs = points(value);
  return glyphs.length <= limit ? value : `…${glyphs.slice(glyphs.length - Math.max(0, limit - 1)).join('')}`;
};

// ---------------------------------------------------------------------------
// The title
// ---------------------------------------------------------------------------

/** What the window is saying about this conversation. */
export type TerminalActivity = 'ready' | 'working' | 'needs-you';

export interface TitleInput {
  readonly state: TerminalActivity;
  /** The conversation's name. Absent before it has one — the folder stands in. */
  readonly title?: string;
  /** The project the conversation is in, already shortened by the caller. */
  readonly folder: string;
  /** How many conversations are waiting on a person, when it is more than this one. */
  readonly needing?: number;
}

/** Padded to, and never longer than, this many code points. See the header. */
export const TITLE_WIDTH = 80;

/** The folder's share of the width. The rest belongs to the conversation. */
const FOLDER_WIDTH = 24;

/**
 * The largest count worth printing. Nobody has a hundred conversations waiting
 * on them, and the cap is what keeps the state word a bounded width — with it,
 * the conversation's share of the title can be computed rather than guessed at.
 */
const MAX_NEEDING = 99;

/** The separator, with the space either side that makes it a separator. */
const SEPARATOR = ' · ';

/**
 * The three states, in Artemis's words.
 *
 * Gemini draws `✋ Action Required`, `⏲ Working…` and `◇ Ready`; the shapes are
 * right and the words are not ours. The glyphs are the rail's own — the `⚿` a
 * conversation wears when it has stopped to ask permission, a braille frame for
 * work in flight, the diamond for a conversation with nothing left to do. The
 * working glyph does not animate: a title rewritten ten times a second is a
 * taskbar button redrawn ten times a second, for motion nobody is looking at.
 */
function lead(state: TerminalActivity, needing: number | undefined): string {
  switch (state) {
    case 'needs-you': {
      const count = typeof needing === 'number' && Number.isFinite(needing) ? Math.floor(needing) : 1;
      if (count <= 1) return '⚿ needs you';
      return `⚿ ${count > MAX_NEEDING ? `${MAX_NEEDING}+` : count} need you`;
    }
    case 'working':
      return '⠹ working';
    case 'ready':
      return '◇ ready';
  }
}

/**
 * The title, at exactly `TITLE_WIDTH` code points.
 *
 * Reads as `⚿ needs you · Rework the parser (artemis)`. With no conversation
 * name yet the folder becomes the subject — `◇ ready · artemis` — because
 * `◇ ready · (artemis)` is a hole where a name should be.
 */
export function titleFor(input: TitleInput): string {
  const head = lead(input.state, input.needing);
  const folder = tailEllipsis(plain(input.folder, FOLDER_WIDTH * 2), FOLDER_WIDTH);
  const name = plain(input.title ?? '', TITLE_WIDTH * 2);
  if (name.length === 0) return pad(folder.length === 0 ? head : `${head}${SEPARATOR}${folder}`);
  const parenthetical = folder.length === 0 ? '' : ` (${folder})`;
  const room = TITLE_WIDTH - points(head).length - SEPARATOR.length - points(parenthetical).length;
  return pad(`${head}${SEPARATOR}${headEllipsis(name, room)}${parenthetical}`);
}

/**
 * The width invariant, in one place: out of here comes `TITLE_WIDTH` code
 * points, never more and never fewer, whatever the arithmetic above did.
 */
function pad(value: string): string {
  const width = points(value).length;
  return width >= TITLE_WIDTH ? cut(value, TITLE_WIDTH) : value + ' '.repeat(TITLE_WIDTH - width);
}

/**
 * Set the window title.
 *
 * OSC 0 rather than OSC 2: it sets the icon name as well as the title, which is
 * what a minimised window and a tmux window flag read, and every terminal that
 * honours one honours it. `false` means nothing was written — not a terminal,
 * or the title was switched off.
 */
export function setTitle(title: string, deps: TerminalDeps = {}): boolean {
  const wired = wire(deps);
  if (chromeMuted(wired)) return false;
  return emit(wired, forTerminal(wired, osc(`0;${safe(title, TITLE_WIDTH * 4)}`)));
}

/**
 * Hand the title back.
 *
 * There is no portable restore. XTerm has a title stack (`ESC[22;2t` to push,
 * `ESC[23;2t` to pop) but too few terminals implement it, and a push on start
 * needs a matching pop on every exit — including the ones that are a crash. An
 * unbalanced stack leaves the *wrong* title behind, which is worse than none.
 * So this writes an empty title: the terminal falls back to its own default,
 * which is usually the shell's, which the next prompt rewrites within a
 * keystroke.
 */
export function clearTitle(deps: TerminalDeps = {}): boolean {
  const wired = wire(deps);
  if (chromeMuted(wired)) return false;
  return emit(wired, forTerminal(wired, osc('0;')));
}

// ---------------------------------------------------------------------------
// The taskbar light
// ---------------------------------------------------------------------------

/**
 * What the taskbar should show. `'done'` and `'clear'` are the same sequence:
 * the protocol has no finished state that is not sticky, and a progress bar
 * left sitting at a triumphant 100% forever is the bug everyone who has used a
 * misbehaving installer knows by sight. They stay two names because the call
 * sites mean two different things.
 */
export type ProgressActivity = 'working' | 'done' | 'error' | 'clear';

/** The OSC 9;4 state codes: 0 removes the bar, 2 is error, 3 is indeterminate. */
const PROGRESS_CODE: Record<ProgressActivity, string> = { working: '3', done: '0', error: '2', clear: '0' };

/**
 * Terminals known to read OSC 9;4. There is no way to ask, and a terminal that
 * does not know it prints it, so this is an allow-list keyed on the variables
 * these terminals set for themselves. ConEmu is skipped when its ANSI emulation
 * is off, because then nothing there is parsing escapes at all.
 */
function paintsProgress(deps: Wired): boolean {
  if (present(deps.env['WT_SESSION'])) return true;
  const conemu = deps.env['ConEmuANSI'];
  if (conemu !== undefined && conemu.length > 0 && conemu.toUpperCase() !== 'OFF') return true;
  const program = (deps.env['TERM_PROGRAM'] ?? '').toLowerCase();
  return program === 'ghostty' || program === 'iterm.app';
}

/**
 * The taskbar progress light: an indeterminate pulse while a turn runs, red on
 * a failure, nothing once the work is over.
 *
 * No progress value is sent with any of them. A turn has no percentage — the
 * agent does not know how much of it is left either — and claiming one would be
 * a lie drawn to two decimal places.
 */
export function progressState(state: ProgressActivity, deps: TerminalDeps = {}): boolean {
  const wired = wire(deps);
  if (chromeMuted(wired) || !paintsProgress(wired)) return false;
  return emit(wired, forTerminal(wired, osc(`9;4;${PROGRESS_CODE[state]}`)));
}

// ---------------------------------------------------------------------------
// The bell
// ---------------------------------------------------------------------------

/**
 * How this terminal is told that something happened.
 *
 *  - `osc9` — iTerm2's one-line notification, since adopted by Ghostty, kitty,
 *    WezTerm and Warp. A real system notification, with a real sound.
 *  - `osc777` — rxvt's `notify`, which is what a terminal talking to a Linux
 *    desktop's notification daemon understands. Carries a title as well.
 *  - `bell` — the one thing every terminal does something with, and what the
 *    terminals that manage their own attention signals want: the macOS
 *    Terminal's dock badge, VS Code's tab dot, tmux's window flag.
 *  - `none` — not a terminal, or switched off.
 */
export type NotificationMethod = 'osc9' | 'osc777' | 'bell' | 'none';

const FORCED: Readonly<Record<string, NotificationMethod>> = { osc9: 'osc9', osc777: 'osc777', bell: 'bell', off: 'none', '0': 'none', false: 'none' };

/**
 * Which route this terminal gets.
 *
 * Gemini's auto rule, which is the closest thing to a standard here: the
 * terminals known to implement OSC 9 get it, the terminals with their own idea
 * of attention get a bell, and everything else on a desktop gets OSC 777.
 * Windows without a recognised terminal gets the bell instead, because a legacy
 * console host prints OSC 777 rather than acting on it.
 *
 * `ARTEMIS_TUI_NOTIFY` may name a method outright. That matters over SSH, where
 * `TERM_PROGRAM` belongs to a login shell that never ran and the guess lands on
 * OSC 777 for a terminal that may not speak it.
 */
export function notificationMethod(deps: TerminalDeps = {}): NotificationMethod {
  const wired = wire(deps);
  if (wired.stdout === undefined || wired.stdout.isTTY !== true) return 'none';
  const setting = (wired.env['ARTEMIS_TUI_NOTIFY'] ?? '').trim().toLowerCase();
  const forced = FORCED[setting];
  if (forced !== undefined) return forced;
  return autoMethod(wired);
}

function autoMethod(deps: Wired): NotificationMethod {
  const program = (deps.env['TERM_PROGRAM'] ?? '').toLowerCase();
  const term = (deps.env['TERM'] ?? '').toLowerCase();
  if (program === 'iterm.app' || program === 'ghostty' || program === 'wezterm' || program === 'warpterminal' || program === 'warp') return 'osc9';
  if (present(deps.env['KITTY_WINDOW_ID']) || term.includes('kitty')) return 'osc9';
  if (present(deps.env['WEZTERM_PANE'])) return 'osc9';
  if (program === 'apple_terminal' || program === 'vscode' || program === 'alacritty') return 'bell';
  // Alacritty has never set `TERM_PROGRAM`; it is identified by its own
  // variables and by its terminfo name.
  if (present(deps.env['ALACRITTY_WINDOW_ID']) || present(deps.env['ALACRITTY_SOCKET']) || term.startsWith('alacritty')) return 'bell';
  if (present(deps.env['WT_SESSION']) || deps.platform === 'win32') return 'bell';
  return 'osc777';
}

/**
 * Why the terminal is being rung.
 *
 * The kind does not change the bytes — none of these protocols carries an
 * urgency — but it belongs to the event rather than the call site, because the
 * decision to ring at all is made per kind and any future rule about that
 * (ringing only for `needs-you`, say) has one place to live.
 */
export interface AttentionEvent {
  readonly kind: AttentionKind;
  readonly title: string;
  readonly body: string;
}

/** Long enough for a conversation's name and a sentence; short enough not to be a payload. */
const NOTIFY_TITLE_LIMIT = 120;
const NOTIFY_BODY_LIMIT = 240;

/**
 * Ring the terminal, and say how it was rung.
 *
 * OSC 9 has one field, so it gets the body alone — the conversation is already
 * named in the window title, and a caller who wants it in the notification says
 * so in the body. A semicolon in an OSC 777 title would look like the end of
 * that field, so it becomes a comma. The bell is not wrapped for tmux: see the
 * header. `'none'` is returned whenever nothing was written, the failed write
 * included.
 */
export function notify(event: AttentionEvent, deps: TerminalDeps = {}): NotificationMethod {
  const wired = wire(deps);
  const method = notificationMethod(deps);
  if (method === 'none') return 'none';
  const title = plain(event.title, NOTIFY_TITLE_LIMIT).replaceAll(';', ',');
  const body = plain(event.body, NOTIFY_BODY_LIMIT);
  const bytes = method === 'bell' ? BEL : forTerminal(wired, method === 'osc9' ? osc(`9;${body}`) : osc(`777;notify;${title};${body}`));
  return emit(wired, bytes) ? method : 'none';
}

// ---------------------------------------------------------------------------
// Waiting until nobody is looking
// ---------------------------------------------------------------------------

export type AttentionKind = 'needs-you' | 'finished';

/** A permission prompt is urgent; six seconds of stillness is enough to believe you left. */
export const NEEDS_YOU_IDLE_MS = 6_000;

/** A finished turn is not urgent. A minute of stillness means you really are elsewhere. */
export const FINISHED_IDLE_MS = 60_000;

const IDLE_MS: Record<AttentionKind, number> = { 'needs-you': NEEDS_YOU_IDLE_MS, finished: FINISHED_IDLE_MS };

/** A timer handle, whatever the clock in use calls one. */
export type TimerHandle = unknown;

export interface Clock {
  readonly setTimeout: (fire: () => void, ms: number) => TimerHandle;
  readonly clearTimeout: (handle: TimerHandle) => void;
  readonly now: () => number;
}

/**
 * The real clock. The timer is unreferenced: a bell that has not rung yet must
 * never be the reason the process will not exit.
 */
export const systemClock: Clock = {
  setTimeout: (fire, ms) => {
    const handle = setTimeout(fire, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
  now: () => Date.now(),
};

/**
 * The idle rule: ring only at somebody who has stopped typing.
 *
 * Both kinds hang off the same last-keystroke time, so a person working through
 * a long answer hears nothing; the moment they stop, the clock that was already
 * running is the one that decides. `arm` counts from that keystroke rather than
 * from now, because someone who wandered off a minute ago is already away — but
 * it never calls back synchronously even so, since a caller must be able to arm
 * and disarm in the same tick without re-entering itself. Firing disarms: an
 * event is one bell, and the keystroke that follows must not produce a second.
 */
export class AttentionTimer {
  readonly #clock: Clock;
  readonly #delays: Record<AttentionKind, number>;
  readonly #armed = new Map<AttentionKind, TimerHandle>();
  readonly #fires = new Map<AttentionKind, () => void>();
  #touched: number;

  constructor(options: { readonly clock?: Clock; readonly delays?: Partial<Record<AttentionKind, number>> } = {}) {
    this.#clock = options.clock ?? systemClock;
    this.#delays = { ...IDLE_MS, ...options.delays };
    this.#touched = this.#clock.now();
  }

  /** A keystroke. Pushes everything armed back out to its full delay. */
  touch(): void {
    this.#touched = this.#clock.now();
    for (const kind of [...this.#armed.keys()]) this.#schedule(kind, this.#delays[kind]);
  }

  /** Ring `fire` once the person has been still for this kind's delay. Arming twice replaces the first. */
  arm(kind: AttentionKind, fire: () => void): void {
    this.#fires.set(kind, fire);
    this.#schedule(kind, Math.max(0, this.#delays[kind] - (this.#clock.now() - this.#touched)));
  }

  /** The turn moved on, or the person came back. Nothing rings. */
  disarm(kind: AttentionKind): void {
    const handle = this.#armed.get(kind);
    if (handle !== undefined) this.#clock.clearTimeout(handle);
    this.#armed.delete(kind);
    this.#fires.delete(kind);
  }

  /** On the way out: no pending timer outlives the component that armed it. */
  disarmAll(): void {
    for (const kind of [...this.#armed.keys()]) this.disarm(kind);
  }

  isArmed(kind: AttentionKind): boolean {
    return this.#armed.has(kind);
  }

  /** How long the person has been still, for a caller that wants to decide for itself. */
  idleMs(): number {
    return this.#clock.now() - this.#touched;
  }

  #schedule(kind: AttentionKind, ms: number): void {
    const existing = this.#armed.get(kind);
    if (existing !== undefined) this.#clock.clearTimeout(existing);
    this.#armed.set(
      kind,
      this.#clock.setTimeout(() => {
        this.#armed.delete(kind);
        const fire = this.#fires.get(kind);
        this.#fires.delete(kind);
        fire?.();
      }, ms),
    );
  }
}
