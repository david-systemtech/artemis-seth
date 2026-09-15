/**
 * The terminal's contract: what the title says in each state and how wide it
 * is, the exact bytes of every sequence in and out of tmux, which terminal gets
 * which route, and that the bell waits for a person to stop typing.
 *
 * Nothing here touches a real terminal. The environment, the output stream, the
 * platform and the clock are all injected, so the Windows Terminal assertions
 * run on Linux, the iTerm2 ones run everywhere, and a minute of idle time takes
 * no time at all.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AttentionTimer,
  FINISHED_IDLE_MS,
  NEEDS_YOU_IDLE_MS,
  TITLE_WIDTH,
  clearTitle,
  notificationMethod,
  notify,
  progressState,
  setTitle,
  titleFor,
  type Clock,
  type NotificationMethod,
  type TerminalDeps,
  type TerminalStdout,
  type TitleInput,
} from './terminal.js';

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

/** Code points, the same unit the module pads in. */
const width = (value: string): number => Array.from(value).length;

function stdoutSpy(isTTY = true): { readonly writes: string[]; readonly stdout: TerminalStdout } {
  const writes: string[] = [];
  return {
    writes,
    stdout: {
      write(chunk: string): boolean {
        writes.push(chunk);
        return true;
      },
      isTTY,
    },
  };
}

/** A terminal, its environment, and somewhere to catch what Artemis writes to it. */
function terminal(env: NodeJS.ProcessEnv = {}, options: { readonly isTTY?: boolean; readonly platform?: string } = {}): {
  readonly writes: string[];
  readonly deps: TerminalDeps;
} {
  const spy = stdoutSpy(options.isTTY ?? true);
  return { writes: spy.writes, deps: { env, stdout: spy.stdout, platform: options.platform ?? 'linux' } };
}

/** A stream that has gone away mid-write, which is a closed pipe and not news. */
const broken: TerminalStdout = {
  write(): boolean {
    throw new Error('EPIPE');
  },
  isTTY: true,
};

// ---------------------------------------------------------------------------

describe('titleFor', () => {
  const conversation = { title: 'Rework the parser', folder: 'artemis' } as const;

  it('draws each state with its own glyph and the word Artemis uses for it', () => {
    expect(titleFor({ state: 'ready', ...conversation }).trimEnd()).toBe('◇ ready · Rework the parser (artemis)');
    expect(titleFor({ state: 'working', ...conversation }).trimEnd()).toBe('⠹ working · Rework the parser (artemis)');
    expect(titleFor({ state: 'needs-you', ...conversation }).trimEnd()).toBe('⚿ needs you · Rework the parser (artemis)');
  });

  it('counts the conversations waiting, once more than one is', () => {
    expect(titleFor({ state: 'needs-you', ...conversation, needing: 2 }).trimEnd()).toBe('⚿ 2 need you · Rework the parser (artemis)');
    expect(titleFor({ state: 'needs-you', ...conversation, needing: 17 }).startsWith('⚿ 17 need you · ')).toBe(true);
  });

  it('stays singular for one, for none, and for no count at all', () => {
    for (const needing of [undefined, 0, 1, -3, Number.NaN]) {
      expect(titleFor({ state: 'needs-you', ...conversation, needing }).startsWith('⚿ needs you · ')).toBe(true);
    }
  });

  it('caps an implausible count rather than letting it eat the title', () => {
    expect(titleFor({ state: 'needs-you', ...conversation, needing: 100 }).startsWith('⚿ 99+ need you · ')).toBe(true);
    expect(titleFor({ state: 'needs-you', ...conversation, needing: 4_000 }).startsWith('⚿ 99+ need you · ')).toBe(true);
  });

  it('lets the folder be the subject when the conversation has no name yet', () => {
    expect(titleFor({ state: 'ready', folder: 'artemis' }).trimEnd()).toBe('◇ ready · artemis');
    expect(titleFor({ state: 'working', title: '   ', folder: 'artemis' }).trimEnd()).toBe('⠹ working · artemis');
    expect(titleFor({ state: 'ready', folder: '' }).trimEnd()).toBe('◇ ready');
  });

  it('omits the parentheses when there is no folder to name', () => {
    expect(titleFor({ state: 'working', title: 'Rework the parser', folder: '' }).trimEnd()).toBe('⠹ working · Rework the parser');
  });

  it('is exactly one fixed width, whatever it was given, so the taskbar button holds still', () => {
    const inputs: readonly TitleInput[] = [
      { state: 'ready', folder: '' },
      { state: 'ready', folder: 'artemis' },
      { state: 'working', title: 'Fix', folder: 'artemis' },
      { state: 'needs-you', title: 'x'.repeat(400), folder: 'y'.repeat(400), needing: 99 },
      { state: 'needs-you', title: '🙂'.repeat(60), folder: 'artemis', needing: 2 },
      { state: 'working', title: 'Rework the parser so that it stops swallowing the trailing comma', folder: 'artemis-worktree-seventeen' },
    ];
    for (const input of inputs) expect(width(titleFor(input))).toBe(TITLE_WIDTH);
  });

  it('cuts the conversation name and never the state or the folder', () => {
    const title = titleFor({ state: 'working', title: `${'a'.repeat(200)} the end`, folder: 'artemis' });

    expect(title.startsWith('⠹ working · ')).toBe(true);
    expect(title.endsWith(' (artemis)')).toBe(true);
    expect(title).toContain('…');
    expect(title).not.toContain('the end');
  });

  it('keeps the tail of an over-long folder, which is the part that names it', () => {
    const folder = 'projects/clients/acme/artemis-worktree-seventeen';

    expect(titleFor({ state: 'ready', title: 'Fix', folder })).toContain(`(…${folder.slice(-23)})`);
  });

  it('flattens the control characters that would end the sequence early', () => {
    const hostile = `Fix${BEL}the${ESC}]0;evil${BEL} parser\nnow`;
    const title = titleFor({ state: 'ready', title: hostile, folder: `artemis${BEL}` });

    expect(title).not.toContain(ESC);
    expect(title).not.toContain(BEL);
    expect(title.trimEnd()).toBe('◇ ready · Fix the ]0;evil parser now (artemis)');
  });
});

// ---------------------------------------------------------------------------

describe('setTitle', () => {
  it('writes OSC 0, BEL-terminated, with the padding intact', () => {
    const term = terminal();
    const title = titleFor({ state: 'ready', title: 'Fix', folder: 'artemis' });

    expect(setTitle(title, term.deps)).toBe(true);
    expect(term.writes).toEqual([`${ESC}]0;${title}${BEL}`]);
    expect(width(term.writes[0] ?? '')).toBe(TITLE_WIDTH + 5);
  });

  it('wraps the sequence for tmux, doubling the escape inside it', () => {
    const term = terminal({ TMUX: '/tmp/tmux-1000/default,123,0' });

    setTitle('◇ ready', term.deps);

    expect(term.writes).toEqual([`${ESC}Ptmux;${ESC}${ESC}]0;◇ ready${BEL}${ESC}\\`]);
  });

  it('writes nothing when stdout is not a terminal', () => {
    const term = terminal({}, { isTTY: false });

    expect(setTitle('◇ ready', term.deps)).toBe(false);
    expect(term.writes).toEqual([]);
  });

  it('writes nothing when ARTEMIS_TUI_NO_TITLE is set, and writes when it is not', () => {
    const off = terminal({ ARTEMIS_TUI_NO_TITLE: '1' });
    const on = terminal({ ARTEMIS_TUI_NO_TITLE: '0' });

    expect(setTitle('◇ ready', off.deps)).toBe(false);
    expect(off.writes).toEqual([]);
    expect(setTitle('◇ ready', on.deps)).toBe(true);
  });

  it('strips a control character a caller passed straight through', () => {
    const term = terminal();

    setTitle(`ready${BEL}${ESC}]0;evil`, term.deps);

    expect(term.writes).toEqual([`${ESC}]0;ready  ]0;evil${BEL}`]);
  });

  it('survives a stream that has gone away', () => {
    expect(setTitle('◇ ready', { env: {}, stdout: broken, platform: 'linux' })).toBe(false);
  });
});

describe('clearTitle', () => {
  it('writes an empty title, because there is no portable restore', () => {
    const term = terminal();

    expect(clearTitle(term.deps)).toBe(true);
    expect(term.writes).toEqual([`${ESC}]0;${BEL}`]);
  });

  it('wraps for tmux and honours the opt-out and the pipe', () => {
    const tmux = terminal({ TMUX: '/tmp/tmux-1000/default,123,0' });
    clearTitle(tmux.deps);
    expect(tmux.writes).toEqual([`${ESC}Ptmux;${ESC}${ESC}]0;${BEL}${ESC}\\`]);

    const off = terminal({ ARTEMIS_TUI_NO_TITLE: '1' });
    expect(clearTitle(off.deps)).toBe(false);
    expect(off.writes).toEqual([]);

    const piped = terminal({}, { isTTY: false });
    expect(clearTitle(piped.deps)).toBe(false);
    expect(piped.writes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('progressState', () => {
  const paints: readonly (readonly [string, NodeJS.ProcessEnv])[] = [
    ['Windows Terminal', { WT_SESSION: '0a1b2c3d-0000-0000-0000-000000000000' }],
    ['ConEmu', { ConEmuANSI: 'ON' }],
    ['Ghostty', { TERM_PROGRAM: 'ghostty' }],
    ['iTerm2', { TERM_PROGRAM: 'iTerm.app' }],
  ];

  it.each(paints)('pulses the taskbar on %s', (_name, env) => {
    const term = terminal(env);

    expect(progressState('working', term.deps)).toBe(true);
    expect(term.writes).toEqual([`${ESC}]9;4;3${BEL}`]);
  });

  const silent: readonly (readonly [string, NodeJS.ProcessEnv])[] = [
    ['a bare xterm', { TERM: 'xterm-256color' }],
    ['the macOS Terminal', { TERM_PROGRAM: 'Apple_Terminal' }],
    ['VS Code', { TERM_PROGRAM: 'vscode' }],
    ['kitty', { KITTY_WINDOW_ID: '1' }],
    ['nothing at all', {}],
    ['ConEmu with ANSI off', { ConEmuANSI: 'OFF' }],
  ];

  it.each(silent)('says nothing on %s, which would print the sequence', (_name, env) => {
    const term = terminal(env);

    expect(progressState('working', term.deps)).toBe(false);
    expect(term.writes).toEqual([]);
  });

  it('removes the bar for both done and clear, and turns it red for an error', () => {
    const term = terminal({ WT_SESSION: 'x' });

    progressState('done', term.deps);
    progressState('clear', term.deps);
    progressState('error', term.deps);

    expect(term.writes).toEqual([`${ESC}]9;4;0${BEL}`, `${ESC}]9;4;0${BEL}`, `${ESC}]9;4;2${BEL}`]);
  });

  it('wraps for tmux', () => {
    const term = terminal({ TERM_PROGRAM: 'ghostty', TMUX: '/tmp/tmux-1000/default,123,0' });

    progressState('working', term.deps);

    expect(term.writes).toEqual([`${ESC}Ptmux;${ESC}${ESC}]9;4;3${BEL}${ESC}\\`]);
  });

  it('is silent off a terminal and when the window chrome is switched off', () => {
    const piped = terminal({ WT_SESSION: 'x' }, { isTTY: false });
    expect(progressState('working', piped.deps)).toBe(false);
    expect(piped.writes).toEqual([]);

    const off = terminal({ WT_SESSION: 'x', ARTEMIS_TUI_NO_TITLE: '1' });
    expect(progressState('working', off.deps)).toBe(false);
    expect(off.writes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('notificationMethod', () => {
  const routes: readonly (readonly [string, NodeJS.ProcessEnv, NotificationMethod])[] = [
    ['iTerm2', { TERM_PROGRAM: 'iTerm.app' }, 'osc9'],
    ['Ghostty', { TERM_PROGRAM: 'ghostty' }, 'osc9'],
    ['WezTerm by its program', { TERM_PROGRAM: 'WezTerm' }, 'osc9'],
    ['WezTerm by its pane', { WEZTERM_PANE: '3' }, 'osc9'],
    ['Warp', { TERM_PROGRAM: 'WarpTerminal' }, 'osc9'],
    ['kitty by its window id', { KITTY_WINDOW_ID: '1' }, 'osc9'],
    ['kitty by its terminfo', { TERM: 'xterm-kitty' }, 'osc9'],
    ['Alacritty by its window id', { ALACRITTY_WINDOW_ID: '9' }, 'bell'],
    ['Alacritty by its terminfo', { TERM: 'alacritty' }, 'bell'],
    ['the macOS Terminal', { TERM_PROGRAM: 'Apple_Terminal' }, 'bell'],
    ['VS Code', { TERM_PROGRAM: 'vscode' }, 'bell'],
    ['Windows Terminal', { WT_SESSION: 'x' }, 'bell'],
    ['a bare xterm on a Linux desktop', { TERM: 'xterm-256color' }, 'osc777'],
    ['a terminal that says nothing about itself', {}, 'osc777'],
  ];

  it.each(routes)('rings %s with %#', (_name, env, expected) => {
    expect(notificationMethod(terminal(env).deps)).toBe(expected);
  });

  it('falls back to the bell on Windows, where a legacy console prints OSC 777', () => {
    expect(notificationMethod(terminal({}, { platform: 'win32' }).deps)).toBe('bell');
  });

  it('is none off a terminal, whatever the terminal claimed to be', () => {
    expect(notificationMethod(terminal({ TERM_PROGRAM: 'ghostty' }, { isTTY: false }).deps)).toBe('none');
  });

  it('is none when switched off', () => {
    for (const value of ['off', 'OFF', ' off ', '0', 'false']) {
      expect(notificationMethod(terminal({ ARTEMIS_TUI_NOTIFY: value, TERM_PROGRAM: 'ghostty' }).deps)).toBe('none');
    }
  });

  it('takes the method it is given, for the SSH hop that loses every clue', () => {
    expect(notificationMethod(terminal({ ARTEMIS_TUI_NOTIFY: 'osc9', TERM: 'xterm-256color' }).deps)).toBe('osc9');
    expect(notificationMethod(terminal({ ARTEMIS_TUI_NOTIFY: 'BELL', TERM_PROGRAM: 'ghostty' }).deps)).toBe('bell');
    expect(notificationMethod(terminal({ ARTEMIS_TUI_NOTIFY: 'osc777', TERM_PROGRAM: 'iTerm.app' }).deps)).toBe('osc777');
  });

  it('ignores a setting it does not recognise', () => {
    expect(notificationMethod(terminal({ ARTEMIS_TUI_NOTIFY: 'yes please', TERM_PROGRAM: 'ghostty' }).deps)).toBe('osc9');
  });
});

describe('notify', () => {
  const event = { kind: 'needs-you', title: 'Artemis', body: 'Rework the parser needs you' } as const;

  it('sends OSC 9 with the body alone, which is all the field there is', () => {
    const term = terminal({ TERM_PROGRAM: 'ghostty' });

    expect(notify(event, term.deps)).toBe('osc9');
    expect(term.writes).toEqual([`${ESC}]9;Rework the parser needs you${BEL}`]);
  });

  it('sends OSC 777 with a title and a body', () => {
    const term = terminal({ TERM: 'xterm-256color' });

    expect(notify({ ...event, kind: 'finished' }, term.deps)).toBe('osc777');
    expect(term.writes).toEqual([`${ESC}]777;notify;Artemis;Rework the parser needs you${BEL}`]);
  });

  it('rings the bell, and nothing else', () => {
    const term = terminal({ TERM_PROGRAM: 'Apple_Terminal' });

    expect(notify(event, term.deps)).toBe('bell');
    expect(term.writes).toEqual([BEL]);
  });

  it('wraps an OSC for tmux but leaves the bell for tmux to handle', () => {
    const osc = terminal({ TERM_PROGRAM: 'ghostty', TMUX: '/tmp/tmux-1000/default,123,0' });
    notify({ ...event, body: 'done' }, osc.deps);
    expect(osc.writes).toEqual([`${ESC}Ptmux;${ESC}${ESC}]9;done${BEL}${ESC}\\`]);

    const bell = terminal({ TERM_PROGRAM: 'vscode', TMUX: '/tmp/tmux-1000/default,123,0' });
    notify(event, bell.deps);
    expect(bell.writes).toEqual([BEL]);
  });

  it('keeps a semicolon out of the OSC 777 title, where it would end the field', () => {
    const term = terminal({ TERM: 'xterm-256color' });

    notify({ kind: 'finished', title: 'Artemis; really', body: 'a; b' }, term.deps);

    expect(term.writes).toEqual([`${ESC}]777;notify;Artemis, really;a; b${BEL}`]);
  });

  it('flattens a control character out of either field', () => {
    const term = terminal({ TERM: 'xterm-256color' });

    notify({ kind: 'finished', title: `Art${ESC}emis`, body: `done${BEL}\nat last` }, term.deps);

    expect(term.writes).toEqual([`${ESC}]777;notify;Art emis;done at last${BEL}`]);
  });

  it('writes nothing and says none off a terminal or when switched off', () => {
    const piped = terminal({ TERM_PROGRAM: 'ghostty' }, { isTTY: false });
    expect(notify(event, piped.deps)).toBe('none');
    expect(piped.writes).toEqual([]);

    const off = terminal({ TERM_PROGRAM: 'ghostty', ARTEMIS_TUI_NOTIFY: 'off' });
    expect(notify(event, off.deps)).toBe('none');
    expect(off.writes).toEqual([]);
  });

  it('says none when the write itself failed', () => {
    expect(notify(event, { env: { TERM_PROGRAM: 'ghostty' }, stdout: broken, platform: 'darwin' })).toBe('none');
  });
});

// ---------------------------------------------------------------------------

/** A clock that only moves when a test says so, and the timers hanging off it. */
function fakeClock(start = 1_000): { readonly clock: Clock; advance: (ms: number) => void; pending: () => number } {
  let now = start;
  let next = 1;
  const timers = new Map<number, { readonly at: number; readonly fire: () => void }>();
  const clock: Clock = {
    setTimeout: (fire, ms) => {
      const id = next;
      next += 1;
      timers.set(id, { at: now + ms, fire });
      return id;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
    now: () => now,
  };
  return {
    clock,
    advance(ms: number): void {
      const target = now + ms;
      for (;;) {
        let due: { readonly id: number; readonly at: number; readonly fire: () => void } | undefined;
        for (const [id, timer] of timers) {
          if (timer.at <= target && (due === undefined || timer.at < due.at)) due = { id, ...timer };
        }
        if (due === undefined) break;
        timers.delete(due.id);
        now = due.at;
        due.fire();
      }
      now = target;
    },
    pending: () => timers.size,
  };
}

describe('AttentionTimer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rings a permission prompt after six seconds of stillness', () => {
    const time = fakeClock();
    const timer = new AttentionTimer({ clock: time.clock });
    const rung: string[] = [];

    timer.arm('needs-you', () => rung.push('needs-you'));

    time.advance(NEEDS_YOU_IDLE_MS - 1);
    expect(rung).toEqual([]);
    time.advance(1);
    expect(rung).toEqual(['needs-you']);
  });

  it('waits a whole minute before mentioning a finished turn', () => {
    const time = fakeClock();
    const timer = new AttentionTimer({ clock: time.clock });
    const rung: string[] = [];

    timer.arm('finished', () => rung.push('finished'));

    time.advance(FINISHED_IDLE_MS - 1);
    expect(rung).toEqual([]);
    time.advance(1);
    expect(rung).toEqual(['finished']);
  });

  it('defers both on every keystroke, so it never rings at someone who is typing', () => {
    const time = fakeClock();
    const timer = new AttentionTimer({ clock: time.clock });
    const rung: string[] = [];

    timer.arm('needs-you', () => rung.push('needs-you'));
    timer.arm('finished', () => rung.push('finished'));

    for (let keystroke = 0; keystroke < 40; keystroke += 1) {
      time.advance(5_000);
      timer.touch();
    }
    expect(rung).toEqual([]);

    time.advance(NEEDS_YOU_IDLE_MS);
    expect(rung).toEqual(['needs-you']);
    time.advance(FINISHED_IDLE_MS);
    expect(rung).toEqual(['needs-you', 'finished']);
  });

  it('counts from the last keystroke rather than from arming', () => {
    const time = fakeClock();
    const timer = new AttentionTimer({ clock: time.clock });
    const rung: string[] = [];

    timer.touch();
    time.advance(NEEDS_YOU_IDLE_MS - 1_000);
    timer.arm('needs-you', () => rung.push('needs-you'));

    time.advance(999);
    expect(rung).toEqual([]);
    time.advance(1);
    expect(rung).toEqual(['needs-you']);
  });

  it('never rings synchronously, even when the wait has already passed', () => {
    const time = fakeClock();
    const timer = new AttentionTimer({ clock: time.clock });
    const rung: string[] = [];

    time.advance(10 * FINISHED_IDLE_MS);
    timer.arm('finished', () => rung.push('finished'));
    expect(rung).toEqual([]);

    time.advance(0);
    expect(rung).toEqual(['finished']);
  });

  it('disarms, and then nothing rings', () => {
    const time = fakeClock();
    const timer = new AttentionTimer({ clock: time.clock });
    const rung: string[] = [];

    timer.arm('needs-you', () => rung.push('needs-you'));
    expect(timer.isArmed('needs-you')).toBe(true);
    timer.disarm('needs-you');
    expect(timer.isArmed('needs-you')).toBe(false);

    time.advance(FINISHED_IDLE_MS);
    expect(rung).toEqual([]);
    expect(time.pending()).toBe(0);
  });

  it('rings once and disarms itself, so a later keystroke does not ring again', () => {
    const time = fakeClock();
    const timer = new AttentionTimer({ clock: time.clock });
    const rung: string[] = [];

    timer.arm('needs-you', () => rung.push('needs-you'));
    time.advance(NEEDS_YOU_IDLE_MS);
    expect(timer.isArmed('needs-you')).toBe(false);

    timer.touch();
    time.advance(FINISHED_IDLE_MS);
    expect(rung).toEqual(['needs-you']);
  });

  it('replaces the callback when a kind is armed twice, and leaves one timer', () => {
    const time = fakeClock();
    const timer = new AttentionTimer({ clock: time.clock });
    const rung: string[] = [];

    timer.arm('needs-you', () => rung.push('first'));
    timer.arm('needs-you', () => rung.push('second'));
    expect(time.pending()).toBe(1);

    time.advance(NEEDS_YOU_IDLE_MS);
    expect(rung).toEqual(['second']);
  });

  it('disarms everything on the way out, so no timer outlives its component', () => {
    const time = fakeClock();
    const timer = new AttentionTimer({ clock: time.clock });
    const rung: string[] = [];

    timer.arm('needs-you', () => rung.push('needs-you'));
    timer.arm('finished', () => rung.push('finished'));
    timer.disarmAll();

    expect(time.pending()).toBe(0);
    time.advance(10 * FINISHED_IDLE_MS);
    expect(rung).toEqual([]);
  });

  it('reports how long the person has been still', () => {
    const time = fakeClock();
    const timer = new AttentionTimer({ clock: time.clock });

    time.advance(4_000);
    expect(timer.idleMs()).toBe(4_000);
    timer.touch();
    expect(timer.idleMs()).toBe(0);
  });

  it('honours delays a caller overrides', () => {
    const time = fakeClock();
    const timer = new AttentionTimer({ clock: time.clock, delays: { 'needs-you': 50 } });
    const rung: string[] = [];

    timer.arm('needs-you', () => rung.push('needs-you'));
    timer.arm('finished', () => rung.push('finished'));

    time.advance(50);
    expect(rung).toEqual(['needs-you']);
  });

  it('runs on the real clock when it is given none', () => {
    vi.useFakeTimers();
    const timer = new AttentionTimer();
    const rung: string[] = [];

    timer.arm('needs-you', () => rung.push('needs-you'));

    vi.advanceTimersByTime(NEEDS_YOU_IDLE_MS - 1);
    expect(rung).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(rung).toEqual(['needs-you']);
  });
});
