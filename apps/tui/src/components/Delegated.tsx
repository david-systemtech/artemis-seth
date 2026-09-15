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
 * ## The clock is no longer this file's own
 *
 * Elapsed time is computed against `hooks/useNow.ts` — a clock that ticks once a
 * second while something is live and stops dead otherwise. This file kept a
 * private copy of exactly that for as long as it was the only thing that needed
 * one; it is not any more, and two copies are two timers waking an idle terminal
 * at two different moments. The alternative — an elapsed number carried in the
 * event — is a store write per task per second to move one digit. The provider's
 * own `durationMs` wins once it arrives, because it measures the work rather
 * than the time since Artemis first heard of it.
 *
 * ## It can be pointed at
 *
 * The strip used to be a readout and nothing else: it said what was running, and
 * doing anything about what it said meant `/tasks` — a modal, over the
 * transcript, listing the same rows again. It is a list with a cursor now.
 * `focused` lights it and draws a `❯` in a gutter every row reserves, which is
 * the rail's rule and is kept here for the rail's reasons: the composer's cursor
 * and this one must never both be lit, and a row must not shift sideways at the
 * moment focus arrives on it.
 *
 * It still has no keys of its own, and that is deliberate. Ink delivers input to
 * one place; the app is that place, and it is what knows that Tab walks composer
 * → rail → strip and what holds a selection steady while the rows are redrawn
 * underneath it. What the strip offers instead is the answer to "what is the
 * cursor on, and what can be done to it": every row carries
 * {@link DelegatedRow.openable} and {@link DelegatedRow.stoppable}, and
 * `onSelect` hands the app the row under the cursor whenever that changes — so
 * Enter and `x` are a lookup rather than a second, divergent reading of
 * `state.tasks`.
 *
 * `openable` is a fact about the provider's own filing rather than a wish. A
 * transcript exists for work that *is* an agent — a `Task`/`Agent` call — and is
 * filed under the id the task list carries; a backgrounded `local_bash` never
 * had one, and a workflow's own id has none either, because its agents each
 * write their own. The desktop answers this with the same two clauses in
 * `taskHasTranscript`, for the same reasons written out at more length.
 *
 * `stoppable` is only ever the task. There is no per-agent stop inside a
 * workflow, and `x` on one agent's row killing the whole workflow is not what
 * anyone pressing it would have meant.
 *
 * ## A workflow unfolds into its agents
 *
 * A workflow row reads `Review 3/3 · Verify 1/4`, which is the shape of the work
 * rather than the work. `expanded` names the task ids whose agents are drawn
 * beneath them, one indented row each:
 *
 *       ↳ Review · Explore · 40s · done
 *
 * — the phase it belongs to, what kind of agent it is, how long it has taken and
 * where it has got to. This is the only place in the terminal those rows can be
 * reached from: a workflow's agents are not tasks and never appear in the task
 * list, so the `agentId` nested in its progress is the one route to the
 * transcript each of them wrote.
 *
 * Unfolded agents are bounded by {@link MAX_AGENT_ROWS} and count their own
 * overflow, separately from {@link MAX_ROWS}. The two caps are separate because
 * they answer to different people: the top-level one bounds what the strip does
 * unasked, and this one bounds what a reader has deliberately opened.
 */

import { useEffect, useRef } from 'react';
import { Box, Text } from 'ink';

import { isTaskLive, type BackgroundTask, type WorkflowAgent } from '@rx-artemis/protocol';
import { formatDuration, formatTokens, oneLine } from '@rx-artemis/transcript';

import { ACCENT } from '../theme.js';
import { useNow } from '../hooks/useNow.js';
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

/**
 * How many agents an unfolded workflow shows before `+n more`.
 *
 * Eight rather than three, because this cap is answering a different question.
 * {@link MAX_ROWS} is what the strip does to a reader who asked for nothing; a
 * fan-out arrives on its own and must not take the screen. An unfolded workflow
 * is a reader who has pressed `→` on that row and is asking to see inside it,
 * and answering with three of twenty would send them to `/tasks` for the thing
 * they just opened. Eight is the number of rows that still leaves a transcript
 * on a short terminal.
 */
export const MAX_AGENT_ROWS = 8;

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
  // Both spellings. `local_agent` is what the CLI actually sends for a
  // delegated agent — observed on a live run — and it arrives a beat before
  // `subagentType` does, so the first frame of every fan-out is a row this map
  // is the only thing naming. `local_subagent` is kept because it costs one
  // line and the kind is an open string the CLI may respell.
  local_agent: 'Subagent',
  local_subagent: 'Subagent',
  monitor: 'Monitor',
};

/**
 * One line of the strip, already in words — and now a thing that can be chosen.
 *
 * Every row here is something a cursor can land on and a key can act on. The
 * overflow counts are deliberately *not* rows for that reason: `+2 more · /tasks`
 * is a sentence about rows that are missing, and a cursor that could stop on it
 * would be a cursor on nothing.
 */
export interface DelegatedRow {
  readonly id: string;
  /**
   * A whole task, or one agent inside an unfolded workflow.
   *
   * The two are drawn differently and answer differently to every key, so the
   * distinction is in the data rather than inferred at the point of use from
   * whether {@link agentId} happens to be set — a queued workflow agent has no
   * id yet and is an agent row all the same.
   */
  readonly kind: 'task' | 'agent';
  /** The task this row is, or the task the agent is running inside. */
  readonly taskId: string;
  /**
   * The conversation behind this row, when there is one.
   *
   * For a task, this is the task's own id: the provider files a subagent's
   * transcript under exactly the id the task list carries. For a workflow's
   * agent it is the id nested in the workflow's progress. Absent when nothing
   * can be opened — see {@link openable}, which is the flag to test.
   */
  readonly agentId?: string;
  /**
   * What kind of thing this is — `Explore`, `Shell`, a workflow's own name.
   *
   * First, and bold, because it is the part that never changes: down a list of
   * rows whose middles are all different lengths, it is the thing the eye can
   * find in the same place every time. An agent row puts its phase here, which
   * is the same promise: the left edge says which part of the run this is.
   */
  readonly label: string;
  /** What it was asked to do. Empty when the label already said it. */
  readonly description: string;
  /** Elapsed, then what it is doing, then what it has spent. */
  readonly detail: string;
  /** Whether Enter on this row opens a transcript. See {@link agentId}. */
  readonly openable: boolean;
  /** Whether `x` on this row asks the provider to stop something. */
  readonly stoppable: boolean;
  /**
   * Whether `→` on this row has anything to show.
   *
   * True only for a workflow that has reported agents. The fold glyph is drawn
   * from this, so a row without one is a row where the key does nothing and
   * says as much by staying quiet.
   */
  readonly unfoldable: boolean;
}

/** What `delegatedRows` is told beyond the tasks themselves. */
export interface DelegatedOptions {
  /**
   * Task ids whose workflow agents are drawn.
   *
   * The app's, not the strip's: which rows are open must survive the strip
   * being redrawn, and the strip is redrawn on every tick of the clock.
   */
  readonly expanded?: ReadonlySet<string>;
}

export interface Delegated {
  readonly rows: readonly DelegatedRow[];
  /** Live tasks past {@link MAX_ROWS}, which the overflow line counts. */
  readonly hidden: number;
  /**
   * Agents an unfolded workflow had no room for, by task id.
   *
   * A map rather than a number because two workflows can be open at once and
   * each owes its own `+n more`, drawn under its own agents.
   */
  readonly hiddenAgents: ReadonlyMap<string, number>;
}

const NOTHING_EXPANDED: ReadonlySet<string> = new Set<string>();

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
  options: DelegatedOptions = {},
): Delegated {
  // `ambient` is the provider asking not to be shown inline — housekeeping it
  // reports for completeness. `/tasks` makes the same exclusion.
  const live = tasks.filter((task) => task.ambient !== true && isTaskLive(task));
  const terse = columns < TERSE_BELOW;
  const expanded = options.expanded ?? NOTHING_EXPANDED;

  const rows: DelegatedRow[] = [];
  const hiddenAgents = new Map<string, number>();

  for (const task of live.slice(0, MAX_ROWS)) {
    const agents = agentsOf(task);
    const openable = hasTranscript(task);
    rows.push({
      id: task.id,
      kind: 'task',
      taskId: task.id,
      agentId: openable ? task.id : undefined,
      label: labelFor(task),
      description: descriptionFor(task),
      detail: terse ? elapsed(task, now) : detailFor(task, now),
      openable,
      // Every row drawn is live, so this is `true` throughout today. It is
      // still read from the task rather than written as one, because what the
      // flag means is "the provider has something left to stop" and the day
      // the strip draws a settled row is not the day to discover that.
      stoppable: isTaskLive(task),
      unfoldable: agents.length > 0,
    });

    if (!expanded.has(task.id)) continue;
    for (const agent of agents.slice(0, MAX_AGENT_ROWS)) rows.push(agentRow(task, agent, now));
    if (agents.length > MAX_AGENT_ROWS) hiddenAgents.set(task.id, agents.length - MAX_AGENT_ROWS);
  }

  return { rows, hidden: Math.max(0, live.length - MAX_ROWS), hiddenAgents };
}

/**
 * A workflow's agents, in the order the script declared them.
 *
 * Sorted by `index` rather than trusted as they arrive: the whole array is
 * replaced on every progress message, and a row that swapped places with its
 * neighbour between two ticks is a row the eye has to find again. The ordinal
 * is stable across updates by contract, which makes it the one safe key.
 */
function agentsOf(task: BackgroundTask): readonly WorkflowAgent[] {
  const agents = task.workflowProgress;
  if (agents === undefined || agents.length === 0) return [];
  return [...agents].sort((a, b) => a.index - b.index);
}

/**
 * Whether this row opens into a conversation.
 *
 * Both clauses are needed and neither implies the other: the kind is what names
 * a delegated agent in the beat before its type arrives, and `subagentType` is
 * only ever set on work that genuinely is one — so a CLI that grows another
 * agent-shaped kind keeps working. Both spellings of the kind are accepted for
 * {@link KIND_LABELS}' reason, which is that the field is an open string.
 *
 * Everything else answers no on purpose. A backgrounded shell is a process and
 * never had a transcript; a workflow's own id has none either, because the
 * transcripts belong to its agents — and those are reached through the rows
 * this strip now unfolds, which is the whole point of unfolding.
 */
function hasTranscript(task: BackgroundTask): boolean {
  return task.kind === 'local_agent' || task.kind === 'local_subagent' || task.subagentType !== undefined;
}

/**
 * One agent of an unfolded workflow: `↳ Review · Explore · 40s · done`.
 *
 * Phase first, for the reason every row puts its label first — it is the part
 * shared with the neighbours above and below, so a phase that is running four
 * agents reads as four rows of one thing rather than four things. The state is
 * passed through as the workflow said it (`start`, `progress`, `done`, `error`,
 * and whatever a later CLI adds), because it is already a word.
 */
function agentRow(task: BackgroundTask, agent: WorkflowAgent, now: number): DelegatedRow {
  const spent = agentElapsed(agent, now);
  return {
    id: `${task.id}#${String(agent.index)}`,
    kind: 'agent',
    taskId: task.id,
    agentId: agent.agentId,
    // A script that never called `phase()` leaves the agent's own label to name
    // it — `build:chat-reliability` says more than a blank column does.
    label: agent.phaseTitle ?? agent.label,
    description: agent.agentType ?? '',
    detail: [spent, agent.state].filter((part) => part !== undefined && part.length > 0).join(' · '),
    // Absent until the agent has actually been spawned, and absent for ever on
    // one answered from the workflow's journal: there is no conversation behind
    // a row for work that never ran.
    openable: agent.agentId !== undefined,
    stoppable: false,
    unfoldable: false,
  };
}

/**
 * How long this agent has been at it, or nothing at all.
 *
 * Nothing, rather than a zero, for an agent that is still queued: `0ms` next to
 * `start` reads as a stopwatch that is broken rather than as work that has not
 * begun. The workflow's own measurement wins when it has one, for the reason
 * {@link elapsed} prefers the provider's.
 */
function agentElapsed(agent: WorkflowAgent, now: number): string | undefined {
  if (agent.durationMs !== undefined) return formatDuration(agent.durationMs);
  if (agent.startedAt === undefined) return undefined;
  return formatDuration(Math.max(0, now - agent.startedAt));
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

/** What the strip says it can do, while it has the focus. */
const HINT = '↑↓ · Enter open · x stop · → unfold · ← fold · Esc back';

export interface DelegatedStripProps {
  readonly tasks: readonly BackgroundTask[];
  /**
   * The width the strip has — the terminal less the rail, not the terminal.
   * Handing it the whole screen is the mistake the status bar's own `columns`
   * exists to prevent.
   */
  readonly columns?: number;
  /**
   * Whether the strip has the focus: the cursor and the hint line are drawn
   * only then, and a strip nobody has tabbed to is the readout it always was.
   */
  readonly focused?: boolean;
  /** Which row the cursor is on. Clamped here; the app need not tidy up. */
  readonly selected?: number;
  /** Task ids whose workflow agents are unfolded. See {@link DelegatedOptions}. */
  readonly expanded?: ReadonlySet<string>;
  /**
   * Told which row the cursor came to rest on, and where.
   *
   * The strip is the only thing that knows what the rows are — they are read
   * out of the tasks on every render, and unfolding changes how many there are
   * — so the app would otherwise have to build the same list a second time to
   * find out what Enter should open. `undefined` when the strip is not focused,
   * which is also how the app hears that its keys have nothing to act on.
   */
  readonly onSelect?: (row: DelegatedRow | undefined, index: number) => void;
}

/**
 * The strip, or nothing at all when nothing is delegated.
 *
 * Nothing is the common case and it must cost nothing: the component returns
 * `null` rather than an empty box, so a conversation that never delegates is
 * laid out exactly as it was before this existed.
 */
export function DelegatedStrip({
  tasks,
  columns,
  focused = false,
  selected = 0,
  expanded,
  onSelect,
}: DelegatedStripProps): React.JSX.Element | null {
  const anyLive = tasks.some((task) => task.ambient !== true && isTaskLive(task));
  const now = useNow(anyLive);
  const spinner = useSpinner(anyLive);
  const { rows, hidden, hiddenAgents } = delegatedRows(tasks, now, columns, { expanded });

  /*
   * The cursor is clamped rather than trusted, because the rows move on their
   * own: a task settles, its row goes, and a selection the app set two seconds
   * ago is now past the end. Clamping here and reporting the result through
   * `onSelect` means the app's number and the drawn cursor cannot disagree.
   */
  const cursor = rows.length === 0 ? -1 : Math.min(Math.max(selected, 0), rows.length - 1);
  const current = focused ? rows[cursor] : undefined;
  /*
   * A key over the parts of the row the app acts on, so the callback fires when
   * the cursor comes to rest on something different — and not once a second as
   * the clock ticks and every row object is rebuilt with the same contents.
   *
   * The callback itself is held in a ref and kept out of the dependencies, or
   * the identity of an inline arrow — which is what every caller will pass —
   * would put it back to once per render, and a `setState` inside it into a
   * loop: new function, new effect, new state, new render.
   */
  const key =
    current === undefined
      ? ''
      : [current.id, cursor, current.openable, current.stoppable, current.unfoldable].join('|');
  const notify = useRef(onSelect);
  useEffect(() => {
    notify.current = onSelect;
  });
  useEffect(() => {
    // `current` and `cursor` are the pair from the render `key` last changed
    // in, which is the pair being announced.
    notify.current?.(current, cursor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (rows.length === 0) return null;

  return (
    <Box flexDirection="column" flexShrink={0} paddingX={1}>
      {rows.map((row, index) => {
        const isSelected = focused && index === cursor;
        // The gutter is reserved whether or not anything is in it: a row that
        // slid two columns sideways the moment Tab reached the strip would be
        // the focus moving the thing it is trying to point at.
        const mark = isSelected ? '❯' : ' ';
        if (row.kind === 'agent') {
          const next = rows[index + 1];
          const last = next === undefined || next.kind !== 'agent' || next.taskId !== row.taskId;
          const overflow = hiddenAgents.get(row.taskId) ?? 0;
          return (
            <Box key={row.id} flexDirection="column" flexShrink={0}>
              <Text wrap="truncate">
                <Text color={ACCENT}>{mark} </Text>
                <Text color={isSelected ? ACCENT : undefined} dimColor={!isSelected}>
                  {`  ↳ ${[row.label, row.description, row.detail]
                    .filter((part) => part.length > 0)
                    .join(' · ')}`}
                </Text>
              </Text>
              {last && overflow > 0 && <Text dimColor>{`      +${String(overflow)} more`}</Text>}
            </Box>
          );
        }
        return (
          <Box key={row.id} flexDirection="row" justifyContent="space-between" flexShrink={0}>
            <Box flexShrink={1} minWidth={0}>
              <Text wrap="truncate">
                <Text color={ACCENT}>{mark} </Text>
                <Text color={ACCENT}>{spinner} </Text>
                {row.unfoldable && (
                  <Text dimColor>{expanded?.has(row.taskId) === true ? '▾ ' : '▸ '}</Text>
                )}
                <Text bold color={isSelected ? ACCENT : undefined}>
                  {row.label}
                </Text>
                {row.description.length > 0 && <Text dimColor>{`  ${row.description}`}</Text>}
              </Text>
            </Box>
            <Box flexShrink={0} marginLeft={1}>
              <Text dimColor>{row.detail}</Text>
            </Box>
          </Box>
        );
      })}
      {hidden > 0 && (
        <Box flexShrink={0}>
          <Text dimColor>{`  +${String(hidden)} more · /tasks`}</Text>
        </Box>
      )}
      {focused && (
        <Box flexShrink={0}>
          <Text dimColor>{`  ${HINT}`}</Text>
        </Box>
      )}
    </Box>
  );
}
