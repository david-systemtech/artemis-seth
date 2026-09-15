/**
 * The two lines under the composer.
 *
 * The first says *what the next message goes out as* — account, model and
 * its effort, permission mode — sitting directly under the thing that sends
 * it, and at its right edge how full the plan is: the 5-hour window, the
 * week, and Fable's own bucket where the plan meters one, the same three the
 * desktop's rings show. The second says what is happening now: a spinner
 * while the provider works, what the keys do, tokens and cost so far.
 *
 *     ⠹ Read apps/tui/src/app.tsx · 1m 04s · 2.3k tok · Enter steers · Esc interrupts
 *
 * That second line used to read `working…` from the first token of a turn to
 * the last, which answers neither question a person has while waiting: what is
 * it doing, and is it still going. So it now says the thing the agent itself
 * last said it was doing — its own reasoning header, or the tool and its
 * target — and how long it has been at it. Only the activity is in the default
 * foreground; the clock, the tokens and the key hints are furniture and stay
 * dim, so the eye lands on the words that change meaning.
 *
 * The second line has one other thing it can become. When this account's plan
 * has stopped serving — or is about to — and no turn is running, the left half
 * turns yellow and reads as an offer rather than a status:
 *
 *     5hr window out · resets 14:30 · hand off to work (12%) · Ctrl+H
 *
 * That is the only place in the app where a limit being reached is mentioned
 * at all, and a line and a key is deliberately the whole of it: ADR 0003 makes
 * a hand off a chosen act, so nothing moves until the key is pressed and the
 * picker it opens is answered. The words are worked out by `failover.ts` and
 * arrive as a finished string, for the reason everything else here does — this
 * file is colours and boxes, and which account has room is not a question a
 * status bar should be asking.
 *
 * None of that is computed here. The activity is folded out of the event
 * stream by `Conversation` and arrives in its state; the elapsed time is this
 * bar's own clock ticking against `turnStartedAt`, because an elapsed number
 * in the store would be a re-render a second to move one digit.
 *
 * Every value here is read from the conversation's state rather than echoed
 * from the last thing chosen — the mode, in particular, is what the provider
 * *said* it started in, which is why it can differ from the picker until the
 * next turn. `bypassPermissions` is painted red: it is the one mode where this
 * line is a warning, and it must never look like the others.
 *
 * Colours are the terminal's own. Each half of each line truncates rather
 * than wraps: a status line that folds onto a second row pushes the layout
 * out of its fixed height, and a clipped account name costs less than that.
 */

import { Box, Text } from 'ink';
import { isTaskLive, planMeterSlots, type PermissionMode, type PlanMeterSlot } from '@rx-artemis/protocol';
import { contextRatio, formatTokens, formatUsd, totalInputTokens } from '@rx-artemis/transcript';

import type { ConversationState } from '../conversation.js';
import { useNow } from '../hooks/useNow.js';
import { useSpinner } from '../hooks/useSpinner.js';
import { ACCENT } from '../theme.js';

/**
 * The mode, as a badge: a glyph that says whether things go through, then the
 * word.
 *
 * The word alone was the whole of it, and the word alone is the one thing on
 * this line that has to be readable without being read — the difference
 * between "everything you asked for is happening" and "you will be asked
 * first" is worth a glyph of its own. `⏵⏵` is the modes that do not stop,
 * `⏸` the modes that do, which is the same pair Claude Code puts under its
 * composer and the same shape a person already knows from every transport
 * control they have ever used.
 *
 * `auto` pauses: the provider asks when it judges the risk real, so it is not
 * a mode that promises to go through. Bypass keeps its shout — it is the one
 * reading here that is a warning rather than a setting — but not its tail:
 * `BYPASS` in red, bold, says it in six characters on a narrow terminal.
 */
const MODE_BADGE: Readonly<Record<PermissionMode, ModeBadge>> = {
  default: { text: '⏸ ask' },
  acceptEdits: { text: '⏵⏵ accept edits', color: 'green' },
  plan: { text: '⏸ plan', color: ACCENT },
  auto: { text: '⏸ auto' },
  dontAsk: { text: "⏵⏵ don't ask", color: 'green' },
  bypassPermissions: { text: '⏵⏵ BYPASS', color: 'red', bold: true },
};

/** A mode drawn: the badge's words, and how they are painted. */
export interface ModeBadge {
  readonly text: string;
  /** The terminal's own colour name, or the accent; undefined is the default foreground. */
  readonly color?: string;
  readonly bold?: boolean;
}

/**
 * How the permission mode reads on the settings line.
 *
 * Pure and exported for the same reason {@link workingLine} is: this is the
 * meaning, and the component is colours and boxes.
 */
export function modeBadge(mode: PermissionMode): ModeBadge {
  return MODE_BADGE[mode];
}

export interface StatusBarProps {
  readonly state: ConversationState;
  /** A transient message with priority over the hints, e.g. "press again to quit". */
  readonly flash?: string;
  /** What the keys do right now, e.g. for the sidebar. */
  readonly hint?: string;
  /**
   * The hand-off offer, when this account's plan has run out or is about to.
   *
   * A finished string rather than the reading it was worked out from: which
   * windows are spent, which accounts have room and which of them can be
   * reached are all questions `failover.ts` answers and `app.tsx` asks, and a
   * bar that took the raw plan readings would end up asking them again.
   */
  readonly failover?: { readonly text: string };
  /** A newer release than this copy, when the daily check found one. */
  readonly update?: string;
  /**
   * How many conversations anywhere in the pool are waiting on the person —
   * the count `Ctrl+]` walks. About every conversation and not this one, which
   * is why it is a number from above rather than something read out of
   * {@link state}.
   */
  readonly needing?: number;
  /**
   * The width this bar actually has — the terminal less the rail, not the
   * terminal. Handing it the whole screen is how the bars came to cost
   * "BYPASS PERMISSIONS" its tail on a terminal wide enough for both.
   */
  readonly columns?: number;
}

/**
 * A window's fullness as a bar.
 *
 * Two rules keep it from lying, and both matter more than the arithmetic:
 * any use at all lights the first cell, so a window that has been started on
 * never reads as untouched; and the last cell is held back until the window
 * really is full, so a full bar means full rather than "nearly".
 */
export function meterBar(utilization: number, cells: number): string {
  if (cells <= 0) return '';
  const exact = Math.round((utilization / 100) * cells);
  const floor = utilization > 0 ? 1 : 0;
  const ceiling = utilization >= 100 ? cells : cells - 1;
  const filled = Math.max(floor, Math.min(exact, ceiling));
  return '█'.repeat(filled) + '░'.repeat(cells - filled);
}

/**
 * Colour by pressure, in the terminal's own colours — and by the desktop's
 * thresholds (`PlanUsageMeter.toneFor`), so an account is never amber in one
 * app and red in the other. Pessimistic on purpose: a window at 75% is worth
 * noticing before it stops you, because the reset can be hours away. The
 * provider's verdict outranks the number — a window it is rejecting on is at
 * the far end whatever its stale percentage reads.
 */
export function meterTone(utilization: number | null, status?: string): 'green' | 'yellow' | 'red' | undefined {
  if (status === 'rejected') return 'red';
  if (utilization === null) return undefined;
  if (utilization >= 90) return 'red';
  if (utilization >= 75) return 'yellow';
  return 'green';
}

/**
 * How many cells each bar gets, or none at all.
 *
 * The readings sit in a box that does not shrink, so every cell here is a
 * column taken from the account and model line beside it, which truncates.
 * Three bars cost three times what they look like they cost, and eight cells
 * each was enough to push "BYPASS PERMISSIONS" — the one word on that line
 * nobody should have to guess at — off the end of a 140-column terminal.
 * `columns` is what this bar has rather than what the screen has, which is
 * the other half of the same mistake. On a narrow terminal the number alone
 * is worth more than a picture of it.
 */
export function meterCells(columns: number): number {
  if (columns >= 118) return 5;
  if (columns >= 98) return 4;
  return 0;
}

/**
 * One window's reading, coloured by pressure: red at 90, yellow at 75 — the
 * desktop's own thresholds, pessimistic on purpose because a reset can be
 * hours away. A window the provider is rejecting on is red whatever its
 * stale percentage reads, and says so.
 *
 * The bar is the same reading again, in a shape that can be taken in without
 * being read: which window is filling up is then a glance rather than three
 * numbers to compare. The number stays — it is the precise one, and the bar
 * at this size cannot be.
 */
function PlanReading({ slot, cells }: { readonly slot: PlanMeterSlot; readonly cells: number }): React.JSX.Element {
  const { utilization, status } = slot.window;
  const rejected = status === 'rejected';
  const pct = utilization === null ? (rejected ? '!' : '—') : `${String(Math.round(utilization))}%`;
  const tone = meterTone(utilization, status);
  const hot = tone === 'red';
  // The filled cells carry the tone; the empty ones stay dim, so the bar
  // reads as a level rather than a coloured block of fixed length.
  const bar = utilization === null ? '' : meterBar(utilization, cells);
  const filled = bar.replace(/░+$/, '');
  const empty = bar.slice(filled.length);
  return (
    <Text>
      <Text dimColor>{slot.label} </Text>
      {cells > 0 && utilization !== null && (
        <Text>
          <Text color={tone}>{filled}</Text>
          <Text dimColor>{empty}</Text>{' '}
        </Text>
      )}
      <Text color={tone} bold={hot} dimColor={tone === undefined}>
        {rejected ? `${pct} out` : pct}
      </Text>
    </Text>
  );
}

/**
 * How long one unchanging thought may hold the line before the spinner warns.
 *
 * Borrowed from Claude Code, which colours its spinner once a turn has been
 * quiet for a while, and kept honest about what it can actually know: a model
 * that has thought the same thought for three quarters of a minute without
 * reaching for a tool is *usually* working on something hard, and
 * occasionally stuck. The signal is a colour rather than a word for exactly
 * that reason — it says "worth a glance", which is all it is entitled to say.
 * A tool call resets it, because tool calls are proof of progress.
 */
export const STALLED_MS = 45_000;

/**
 * Elapsed time for a line that redraws once a second.
 *
 * Not `formatDuration`, deliberately. That one is built for a finished
 * measurement and prints `450ms` and `3.4s` — a precision this line cannot
 * honour, since it only looks at the clock once a second — and it prints
 * `1m 4s`, which is a character narrower than `1m 14s`. On a line that
 * redraws every second, a field that changes width shuffles everything to the
 * right of it, twice a minute, for the whole turn. Zero-padding costs one
 * character and buys a column that holds still.
 */
export function elapsedClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (n: number): string => String(n).padStart(2, '0');
  if (total < 60) return `${String(seconds)}s`;
  if (hours === 0) return `${String(minutes)}m ${pad(seconds)}s`;
  return `${String(hours)}h ${pad(minutes)}m`;
}

/**
 * The left half of the second line, in words.
 *
 * Split the way it is drawn: {@link activity} is what the agent is doing and
 * gets the default foreground, {@link details} is everything that is merely
 * true and is dim. Keeping the two apart here is what stops the component
 * having to know which part of a joined string to colour.
 */
export interface WorkingLine {
  /** What is happening, in the agent's own words where it has said any. */
  readonly activity: string;
  /** Elapsed, tokens, waiting messages, keys — joined with ` · `, all dim. */
  readonly details: readonly string[];
  /** The same thought has held the line for {@link STALLED_MS}. */
  readonly stalled: boolean;
}

/**
 * What the line says, for one state at one moment.
 *
 * Pure, and the whole of this bar's logic, so that the component below stays
 * what it should be: colours and boxes. `now` is an argument rather than a
 * call to the clock for the same reason `delegatedRows` takes one — it is what
 * makes the elapsed time and the stall threshold testable at all.
 */
export function workingLine(state: ConversationState, now = Date.now()): WorkingLine {
  const idle = (activity: string): WorkingLine => ({ activity, details: [], stalled: false });
  switch (state.status) {
    case 'idle':
      return idle(state.sessionId === undefined ? 'ready' : 'idle');
    // Unchanged, and the one state that overrules the activity: a tool call
    // parked on a permission prompt is not work in progress, it is a question,
    // and the card above is asking it.
    case 'awaiting_permission':
      return idle('waiting for you');
    default:
      break;
  }

  const { activity } = state;
  const details: string[] = [];
  if (state.turnStartedAt !== undefined) details.push(elapsedClock(now - state.turnStartedAt));
  if (state.turnTokens !== undefined) details.push(`${formatTokens(state.turnTokens)} tok`);
  // Messages the provider has taken and not yet read. The queued strip names
  // them; this is the count, for the glance that does not look up.
  if (state.queued > 0) details.push(`${String(state.queued)} queued`);
  if (state.capabilities.midRunSteering) details.push('Enter steers');
  details.push('Esc interrupts');

  return {
    // `starting…` while the process is still coming up is not a synonym for
    // `working`: nothing has been asked of the model yet.
    activity: activity?.text ?? (state.status === 'starting' ? 'starting…' : 'working'),
    details,
    stalled: activity?.kind === 'thinking' && now - activity.since >= STALLED_MS,
  };
}

/**
 * Which of the three things that can own the second line's left half has it.
 *
 * They are ranked by how long each is true for, shortest first, which is the
 * only ordering that never loses one of them. A flash lasts two seconds and is
 * about the key just pressed, so it goes on top and the thing underneath is
 * still there when it clears. The offer lasts until the window rolls, and
 * covers the working line rather than the other way round because the working
 * line in that state reads `idle` — the offer is only ever made while nothing
 * is running — and "idle" is the least useful true sentence available.
 */
export type LeftHalf =
  | { readonly kind: 'flash'; readonly text: string }
  | { readonly kind: 'failover'; readonly text: string }
  | { readonly kind: 'working' };

export function leftHalf(flash: string | undefined, failover: { readonly text: string } | undefined): LeftHalf {
  if (flash !== undefined) return { kind: 'flash', text: flash };
  if (failover !== undefined) return { kind: 'failover', text: failover.text };
  return { kind: 'working' };
}

/** `3 files`, `+42` and `−7`, kept apart because each is painted differently. */
export interface ChangedSummary {
  readonly files: string;
  readonly added: string;
  readonly removed: string;
}

/**
 * What this conversation has done to the working directory, as three pieces.
 *
 * The one thing on this line that is not about the *turn*: tokens and cost say
 * what was spent, and this says what came of it. It belongs on the bar rather
 * than behind `/diff` because the question it answers — has the agent started
 * writing to my files — is one people ask by glancing, and an answer you have
 * to type a command for is an answer nobody has while the turn is running.
 *
 * Absent until something has actually been edited: a bar reading `0 files`
 * spends columns saying nothing happened. Split into three rather than joined
 * as `summarizeFiles` does, because `+` and `−` carry their own colours here —
 * the one convention every diff everywhere shares — and a component should not
 * have to find the numbers inside a sentence in order to paint them.
 *
 * `−` is the true minus sign, as the desktop's churn counts use: beside a `+`
 * at the same weight, a hyphen reads as punctuation rather than as the other
 * half of a pair.
 */
/**
 * How many conversations are waiting on the person, in the words the window
 * title already uses.
 *
 * The rail draws a glyph per row and the title draws `⚿ 2 need you` to a
 * taskbar nobody can see from here; this is the same reading at eye level, for
 * the case the whole pool exists to create — two conversations parked and one
 * of them stuck, with the screen showing a third. Nothing at all when the
 * count is zero, because a status line reading `0 need you` spends columns
 * saying that nothing is wrong.
 *
 * `2 need you` and not `1 needs you`: the grammar is wrong for one and it is
 * deliberately the same wrong as `titleFor`'s. Two surfaces reporting one
 * number in two different sentences is a worse reading than one ungrammatical
 * sentence in both, and the number is what is being read.
 */
export function needYouLabel(count: number): string | undefined {
  return count > 0 ? `${String(Math.floor(count))} need you` : undefined;
}

export function changedSummary(changed: ConversationState['filesChanged']): ChangedSummary | undefined {
  if (changed === undefined || changed.files === 0) return undefined;
  return {
    files: `${String(changed.files)} file${changed.files === 1 ? '' : 's'}`,
    added: `+${String(changed.added)}`,
    removed: `−${String(changed.removed)}`,
  };
}

export function StatusBar({ state, flash, hint, update, failover, needing = 0, columns = 0 }: StatusBarProps): React.JSX.Element {
  const { settings, usage } = state;
  const badge = modeBadge(settings.permissionMode);
  const tokens = totalInputTokens(usage?.tokens);
  const ratio = contextRatio(usage);
  const cost = usage?.costUsd;
  const slots = planMeterSlots(state.planUsage);
  const changed = changedSummary(state.filesChanged);
  const liveTasks = state.tasks.filter(isTaskLive).length;
  const needYou = needYouLabel(needing);
  const busy = state.status === 'starting' || state.status === 'running';
  const spinner = useSpinner(busy);
  // The clock runs only while there is a turn to time it against, so an idle
  // terminal holds no interval at all.
  const now = useNow(busy && state.turnStartedAt !== undefined);
  const working = workingLine(state, now);
  const left = leftHalf(flash, failover);
  const model = settings.modelLabel ?? settings.model ?? 'default model';
  const details = [
    settings.effort,
    settings.fastMode === true ? 'fast' : undefined,
    settings.ultracode === true ? 'ultracode' : undefined,
  ].filter((part): part is string => part !== undefined);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Box flexShrink={1} minWidth={0}>
        <Text wrap="truncate">
          <Text bold>{settings.profileLabel}</Text>
          <Text dimColor>{` ${settings.providerLabel}`}</Text>
          <Text dimColor>{' · '}</Text>
          <Text>{model}</Text>
          {details.length > 0 && <Text dimColor>{` ${details.join(' ')}`}</Text>}
          <Text dimColor>{' · '}</Text>
          <Text color={badge.color} bold={badge.bold === true}>
            {badge.text}
          </Text>
        </Text>
        </Box>
        <Box flexShrink={0} marginLeft={1}>
          <Text>
            {slots.map((slot, i) => (
              <Text key={slot.id}>
                {i > 0 && <Text dimColor>{' · '}</Text>}
                <PlanReading slot={slot} cells={meterCells(columns)} />
              </Text>
            ))}
          </Text>
        </Box>
      </Box>
      <Box justifyContent="space-between">
        <Box flexShrink={1} minWidth={0}>
        <Text wrap="truncate">
          {left.kind === 'flash' ? (
            <Text color="yellow">{left.text}</Text>
          ) : left.kind === 'failover' ? (
            /* Yellow, which on this line means "a person is the hold-up" — the
               same colour a waiting permission paints it. It is the right
               reading here too: the plan has stopped, and the only thing that
               can move the conversation on is somebody choosing where. */
            <>
              <Text color="yellow">{left.text}</Text>
              {hint !== undefined && <Text dimColor>{` · ${hint}`}</Text>}
            </>
          ) : (
            <>
              {busy && <Text color={working.stalled ? 'yellow' : ACCENT}>{spinner} </Text>}
              <Text dimColor={!busy && state.status !== 'awaiting_permission'} color={state.status === 'awaiting_permission' ? 'yellow' : undefined}>
                {working.activity}
              </Text>
              {working.details.length > 0 && <Text dimColor>{` · ${working.details.join(' · ')}`}</Text>}
              {hint !== undefined && <Text dimColor>{` · ${hint}`}</Text>}
            </>
          )}
        </Text>
        </Box>
        <Box flexShrink={0} marginLeft={1}>
        <Text>
          {tokens !== undefined && (
            <Text dimColor>
              {formatTokens(tokens)} tok{ratio !== undefined ? ` (${String(Math.round(ratio * 100))}%)` : ''}
            </Text>
          )}
          {cost !== undefined && <Text dimColor>{' · '}{formatUsd(cost)}</Text>}
          {/* The count is furniture and the churn is the reading, so only the
              two numbers carry colour. */}
          {changed !== undefined && (
            <Text>
              <Text dimColor>{` · ${changed.files} `}</Text>
              <Text color="green">{changed.added}</Text>
              <Text dimColor> </Text>
              <Text color="red">{changed.removed}</Text>
            </Text>
          )}
          {liveTasks > 0 && <Text color="cyan">{` · ${String(liveTasks)} task${liveTasks === 1 ? '' : 's'}`}</Text>}
          {/* Yellow, which on this line means "a person is the hold-up" — the
              same colour `awaiting_permission` paints the left half. Beside
              the tasks because both are counts of work that is not on the
              screen; before the update notice because one of them can be
              acted on with a keystroke and the other is news. */}
          {needYou !== undefined && <Text color="yellow">{` · ${needYou}`}</Text>}
          {update !== undefined && <Text color="yellow">{` · ${update} is out: artemis-tui --update`}</Text>}
          <Text dimColor>{' · /help'}</Text>
        </Text>
        </Box>
      </Box>
    </Box>
  );
}
