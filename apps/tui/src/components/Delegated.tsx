/**
 * What the agent has delegated, while it is still going.
 * ============================================================================
 *
 *     ⠹ Explore  auth call sites                1m 12s · Grep · 24.1k tok
 *     ⠹ Plan  migration steps                      34s · Read · 8.2k tok
 *     ⠹ review-changes (workflow)      3m 40s · Review 3/3 · Verify 1/4
 *       +2 more · /tasks
 *
 * The strip exists because the transcript cannot answer this question and was
 * never going to. The `Agent` tool backgrounds by default and `Workflow` is
 * always async, so both close their tool call the instant the work *starts* —
 * which draws, in a surface that reads top to bottom and never rewrites itself,
 * a past-tense line saying "delegated to 3 agents" while the three agents are
 * still working. Everything after that point happens outside any turn, and the
 * set of it is replaced as work comes and goes: a row in a thread would have to
 * be either rewritten in place or re-emitted per change, and the second is a log
 * of a list. `TasksPane.tsx` in the desktop makes the same argument at length;
 * this is that pane, folded into four lines.
 *
 * Before this, the only live signal was `· 3 tasks` at the end of the status
 * line — which says that something is delegated and nothing whatever about
 * what, and left `/tasks` (a snapshot, and a modal that covers the transcript)
 * as the only way to find out.
 *
 * ## It is bounded, and it is only ever live work
 *
 * At most {@link MAX_ROWS} rows and one overflow line, because the strip is
 * spending the conversation's own vertical space and a fan-out of twelve must
 * not push the transcript off the screen — past that, `/tasks` is the surface
 * with room. Settled rows are not drawn at all: `state.tasks` keeps them (the
 * moment a task finishes is the moment its result is worth reading) but this
 * answers "what is running now", and a row that lingered after its work was
 * done would make the strip a place where nothing means anything in particular.
 * The whole thing disappears when the last task settles.
 *
 * Order is the order the tasks were delegated in, and rows do not re-sort as
 * they settle — a row that moved would be a row the eye has to find again.
 *
 * ## The clock ticks here
 *
 * Elapsed time is computed against a clock this component owns, ticking once a
 * second while something is live and stopped otherwise. The alternative — an
 * elapsed number carried in the event — is a store write per task per second to
 * move one digit. The provider's own `durationMs` wins once it arrives, because
 * it measures the work rather than the time since Artemis first heard of it.
 */

import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';

import { isTaskLive, type BackgroundTask, type WorkflowAgent } from '@rx-artemis/protocol';
import { formatDuration, formatTokens, oneLine } from '@rx-artemis/transcript';

import { ACCENT } from '../theme.js';
import { useSpinner } from '../hooks/useSpinner.js';

/**
 * How many tasks the strip draws before it defers to `/tasks`.
 *
 * Three, plus the overflow line, so the worst case is four rows of a terminal
 * that may only have thirty. The number is not precious; that the strip has a
 * *fixed* worst case is, because it sits in the column the transcript is trying
 * to use and an unbounded one would hand a twenty-agent workflow the screen.
 */
export const MAX_ROWS = 3;

/** How much of the right-hand readout survives before it is cut. */
const DETAIL_CHARS = 52;

/**
 * The width below which the readout keeps only the elapsed time.
 *
 * The right-hand half does not shrink, so on a narrow terminal every character
 * of `Grep · 24k tok` is a character taken off the *name of the thing running* —
 * and a row reading `review-c… 3m 40s · Review 2/2` has spent the part worth
 * having on the part that is nice to have. Elapsed alone answers the question
 * the strip is really read for, which is whether anything is stuck. The same
 * trade `meterCells` makes when it gives up the plan bars.
 */
const TERSE_BELOW = 76;

/** Phases named in the readout before the rest become an ellipsis. */
const PHASES_SHOWN = 3;

/**
 * Friendly names for the task kinds we know, and the raw value for the rest.
 *
 * {@link BackgroundTask.kind} is an open string by design — the protocol says
 * so, and says a UI should map what it knows and show the raw value otherwise.
 * Hence no fallback to a reassuring word: a row reading `local_sandbox` is a
 * fact, and one reading "Task" is a shrug.
 */
const KIND_LABELS: Readonly<Record<string, string>> = {
  local_bash: 'Shell',
  local_workflow: 'Workflow',
  local_subagent: 'Subagent',
  monitor: 'Monitor',
};

/** One line of the strip, already in words. */
export interface DelegatedRow {
  readonly id: string;
  /**
   * What kind of thing this is — `Explore`, `Shell`, a workflow's own name.
   *
   * First, and bold, because it is the part that never changes: down a list of
   * rows whose middles are all different lengths, it is the thing the eye can
   * find in the same place every time.
   */
  readonly label: string;
  /** What it was asked to do. Empty when the label already said it. */
  readonly description: string;
  /** Elapsed, then what it is doing, then what it has spent. */
  readonly detail: string;
}

export interface Delegated {
  readonly rows: readonly DelegatedRow[];
  /** Live tasks past {@link MAX_ROWS}, which the overflow line counts. */
  readonly hidden: number;
}

/**
 * The strip's contents, as text.
 *
 * Pure and exported because this is the whole of the feature's logic: the
 * provider sends a heterogeneous list of tasks and everything the strip shows
 * is a reading of it. Taking `now` as an argument rather than calling the clock
 * is what lets the reading be tested at all.
 */
export function delegatedRows(
  tasks: readonly BackgroundTask[],
  now: number,
  /** The width the strip has. Narrow terminals get the elapsed time alone. */
  columns = Number.POSITIVE_INFINITY,
): Delegated {
  // `ambient` is the provider asking not to be shown inline — housekeeping it
  // reports for completeness. `/tasks` makes the same exclusion.
  const live = tasks.filter((task) => task.ambient !== true && isTaskLive(task));
  const terse = columns < TERSE_BELOW;
  return {
    rows: live.slice(0, MAX_ROWS).map((task) => ({
      id: task.id,
      label: labelFor(task),
      description: descriptionFor(task),
      detail: terse ? elapsed(task, now) : detailFor(task, now),
    })),
    hidden: Math.max(0, live.length - MAX_ROWS),
  };
}

/** A workflow is known by its script's name; anything else by what kind it is. */
function labelFor(task: BackgroundTask): string {
  if (task.workflowName !== undefined) return `${task.workflowName} (workflow)`;
  // A subagent's *type* occupies the same slot and says strictly more:
  // "Explore" carries everything "Subagent" does, and the answer as well.
  if (task.subagentType !== undefined) return task.subagentType;
  return KIND_LABELS[task.kind] ?? task.kind;
}

/**
 * What it was asked to do, when that is news.
 *
 * A workflow's description is a paragraph and its name is already the label, so
 * it contributes nothing here but width. A task whose description *is* its
 * label — a bare `Shell`, say — would otherwise print its own name twice.
 */
function descriptionFor(task: BackgroundTask): string {
  if (task.workflowName !== undefined) return '';
  const described = oneLine(task.description, 64);
  return described === labelFor(task) ? '' : described;
}

/**
 * The right-hand readout: how long, and how it is going.
 *
 * Built from whatever has arrived rather than a fixed set of fields, because a
 * workflow reports none of the same things a backgrounded `sleep` does. Elapsed
 * leads, and is the one part always present — it is the answer to "is this
 * stuck", which is the question a strip like this is really read for.
 */
function detailFor(task: BackgroundTask, now: number): string {
  const parts = [elapsed(task, now)];
  const phases = summarizePhases(task.workflowProgress);
  if (phases.length > 0) {
    parts.push(phases);
  } else {
    if (task.lastToolName !== undefined) parts.push(task.lastToolName);
    if (task.totalTokens !== undefined) parts.push(`${formatTokens(task.totalTokens)} tok`);
  }
  return oneLine(parts.join(' · '), DETAIL_CHARS);
}

/** The provider's own measure of the work, or the time since we heard of it. */
function elapsed(task: BackgroundTask, now: number): string {
  return formatDuration(Math.max(task.durationMs ?? 0, now - task.startedAt));
}

/** `done` and `error` are both finished; everything else is still going. */
function isAgentSettled(agent: WorkflowAgent): boolean {
  return agent.state === 'done' || agent.state === 'error';
}

/**
 * A workflow's phases as `Review 3/3 · Verify 1/4`.
 *
 * A workflow is the one task whose interior is visible, and the interior is the
 * only honest answer to "how far along": a fan-out of twenty agents reports one
 * elapsed time and one token count whatever stage it is at. Phases keep their
 * declared order, so the readout advances left to right as the script does.
 * Agents a script never gave a phase are counted together at the end rather
 * than dropped — the phaseless workflow is legal, and a bare `4/9` is still an
 * answer.
 */
export function summarizePhases(agents: readonly WorkflowAgent[] | undefined): string {
  if (agents === undefined || agents.length === 0) return '';

  const phases = new Map<number, { title?: string; total: number; settled: number }>();
  let looseTotal = 0;
  let looseSettled = 0;

  for (const agent of agents) {
    if (agent.phaseIndex === undefined) {
      looseTotal += 1;
      if (isAgentSettled(agent)) looseSettled += 1;
      continue;
    }
    const phase = phases.get(agent.phaseIndex) ?? { total: 0, settled: 0 };
    phase.total += 1;
    if (isAgentSettled(agent)) phase.settled += 1;
    // First title wins: every agent in a phase carries the same one, and a
    // later blank must not erase what an earlier entry established.
    if (phase.title === undefined && agent.phaseTitle !== undefined) phase.title = agent.phaseTitle;
    phases.set(agent.phaseIndex, phase);
  }

  const parts = [...phases.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, phase]) => `${phase.title ?? 'phase'} ${String(phase.settled)}/${String(phase.total)}`);
  if (looseTotal > 0) parts.push(`${String(looseSettled)}/${String(looseTotal)} agents`);

  return parts.length > PHASES_SHOWN
    ? `${parts.slice(0, PHASES_SHOWN).join(' · ')} · …`
    : parts.join(' · ');
}

/** A clock that runs only while something is live. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    // Set once on the way in as well: a task that arrives between ticks would
    // otherwise read as having started in the future until the next second.
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export interface DelegatedStripProps {
  readonly tasks: readonly BackgroundTask[];
  /**
   * The width the strip has — the terminal less the rail, not the terminal.
   * Handing it the whole screen is the mistake the status bar's own `columns`
   * exists to prevent.
   */
  readonly columns?: number;
}

/**
 * The strip, or nothing at all when nothing is delegated.
 *
 * Nothing is the common case and it must cost nothing: the component returns
 * `null` rather than an empty box, so a conversation that never delegates is
 * laid out exactly as it was before this existed.
 */
export function DelegatedStrip({ tasks, columns }: DelegatedStripProps): React.JSX.Element | null {
  const anyLive = tasks.some((task) => task.ambient !== true && isTaskLive(task));
  const now = useNow(anyLive);
  const spinner = useSpinner(anyLive);
  const { rows, hidden } = delegatedRows(tasks, now, columns);
  if (rows.length === 0) return null;

  return (
    <Box flexDirection="column" flexShrink={0} paddingX={1}>
      {rows.map((row) => (
        <Box key={row.id} flexDirection="row" justifyContent="space-between" flexShrink={0}>
          <Box flexShrink={1} minWidth={0}>
            <Text wrap="truncate">
              <Text color={ACCENT}>{spinner} </Text>
              <Text bold>{row.label}</Text>
              {row.description.length > 0 && <Text dimColor>{`  ${row.description}`}</Text>}
            </Text>
          </Box>
          <Box flexShrink={0} marginLeft={1}>
            <Text dimColor>{row.detail}</Text>
          </Box>
        </Box>
      ))}
      {hidden > 0 && (
        <Box flexShrink={0}>
          <Text dimColor>{`  +${String(hidden)} more · /tasks`}</Text>
        </Box>
      )}
    </Box>
  );
}
