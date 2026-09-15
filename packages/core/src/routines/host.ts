/**
 * Routines — a host keeps its own appointments.
 * ============================================================================
 *
 * The host that owns `routines.json`, the minute scheduler, and the history of
 * what fired. It grew up in the desktop's main process and moved here so the
 * headless server can keep appointments too: a routine that only fires while
 * a laptop is open is a reminder, and a routine that fires on a server that
 * never sleeps is automation. Both hosts run this same file against their own
 * engine, through the {@link RoutineEngine} seam below.
 *
 * ## A firing is an ordinary run
 *
 * Each due minute starts a fresh run through the ordinary engine — the
 * routine's prompt, directory, profile, model, effort and permission mode — so
 * a routine's work gets everything a typed turn gets for free: a real
 * transcript, session history, the prompt library, ownership attribution. The
 * one difference is a `routineId` stamped into `RunInput.metadata`, which is
 * how firings are found again: the overlap guard reads it off the live-run
 * map, and the history ledger records what each one became.
 *
 * ## Unattended by default
 *
 * A routine fires with nobody in front of it. A new routine therefore opens in
 * `bypassPermissions`, which is the one mode that never parks the run on a
 * question — the point of a schedule is that the work happens without a
 * person, and a prompt raised at 03:00 into an empty room is a run that
 * produced nothing. A routine can be given another mode deliberately; the
 * run then parks exactly as a typed turn would, and the desktop shows it.
 *
 * ## The scheduler runs with no window open
 *
 * This is a timer that does real work unwatched — that is the point of a
 * schedule. On macOS the app outlives its windows, and on a server there are
 * no windows at all: a routine due at 09:00 fires at 09:00 whether or not
 * anything exists to watch it.
 *
 * ## Sleep, and the one catch-up
 *
 * Timers do not fire while the machine sleeps; they fire late, on wake. The
 * tick notices the gap (a minute tick that arrives minutes late is a machine
 * that was asleep, not a timer that drifted) and runs the catch-up rule: for
 * each routine, the *newest* appointment missed during the gap — within seven
 * days — fires once, and older misses are let go. A laptop opened Monday does
 * not replay the weekend. A server does not sleep, but a container that was
 * stopped for a deploy is the same gap seen from the other side.
 *
 * ## Several owners on one host
 *
 * A server keeps routines for every connection that talks to it, and one
 * token must not see or fire another's. The rule is the session ledger's:
 * a routine belongs to a **scope** — the connection's pin, the same
 * `workspaceKey` conversations are filed under — and every read and write
 * that names a scope is answered only for routines in it. The desktop's own
 * host passes no scope and sees everything, which is what one owner means.
 *
 * ## Deliberately host-agnostic
 *
 * Notifications, logging and the engine arrive through injected options
 * rather than imports, for the same reason the desktop's `server.ts` has none
 * of Electron: this file is exercised by vitest in a plain Node environment,
 * and each host's wiring is one line per hook.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

import type {
  AgentEvent,
  PermissionMode,
  ProviderId,
  Routine,
  RoutineDraft,
  RoutineId,
  RoutinePatch,
  RoutineRunRecord,
  RoutineSchedule,
  RoutineSkipReason,
  RoutinesState,
  RoutineSnapshot,
  RunEndReason,
  RunHandle,
  RunId,
  RunInput,
} from '@rx-artemis/protocol';
import {
  isProviderId,
  lastFireBetween,
  MAX_ROUTINE_HISTORY,
  nextFireAt,
  PERMISSION_MODES,
  scheduleMatchesMinute,
  scheduleProblem,
} from '@rx-artemis/protocol';

/** Beside `server.json` and `profiles.json`, and named the way they are. */
export const ROUTINES_CONFIG_FILE = 'routines.json';

/**
 * The mode a routine opens in when it was not given one. See the file
 * header: a schedule is unattended by definition.
 */
export const DEFAULT_ROUTINE_PERMISSION_MODE: PermissionMode = 'bypassPermissions';

/**
 * A tick that lands this much later than the minute it was aimed at is a
 * machine that was asleep (or a process that was suspended), and the catch-up
 * pass runs. Comfortably above worst-case event-loop lag, far below the
 * shortest schedulable interval.
 */
const SLEEP_GAP_MS = 90_000;

/**
 * What a routine host needs from whatever runs turns.
 *
 * Three members, because that is all the scheduler touches: is there an
 * engine at all, start a run, and hear the events that say how it went. The
 * desktop's `EngineHost` and the server's `RunRegistry` both fit behind it
 * in a line each.
 */
export interface RoutineEngine {
  /** False while the engine is still being resolved; a due firing is skipped, not queued. */
  readonly ready: boolean;
  startRun(input: RunInput): Promise<RunHandle>;
  subscribe(listener: (event: AgentEvent) => void): () => void;
}

/** Who a routine belongs to, on a host that keeps them for several clients. */
export interface RoutineOwner {
  /** The scope every read and write is answered within. */
  readonly scope: string;
  /** The connection that created it, for attribution. */
  readonly connectionId: string;
  /**
   * The directory its runs start in — the connection's pin. Fixed by the
   * host, never by the draft: a served run may start nowhere else.
   */
  readonly cwd: string;
}

export interface RoutineHostOptions {
  readonly engine: RoutineEngine;
  /** The host's data directory — where {@link ROUTINES_CONFIG_FILE} lives. */
  readonly dataDir: string;
  /** Push a new state to whoever renders one. A server may pass a no-op. */
  readonly broadcast: (state: RoutinesState) => void;
  /**
   * Show a notification. Injected because this module must stay runnable
   * outside any UI; absent means firings finish silently.
   */
  readonly notify?: (title: string, body: string) => void;
  /**
   * A firing's run announced its session. The server wires this to its
   * ledger, which is what makes the conversation a routine produced listable
   * and resumable by the connection that owns the routine.
   */
  readonly onSession?: (routine: Routine, runId: string, sessionId: string) => void;
  /** Where a failure that must not stop the schedule is said out loud. */
  readonly onError?: (message: string, error: unknown) => void;
}

/** A routine named by a caller whose scope does not hold it — or nobody's. */
export class UnknownRoutineError extends Error {
  constructor(id: RoutineId) {
    super(`No routine "${id}".`);
    this.name = 'UnknownRoutineError';
  }
}

export interface RoutineHost {
  /**
   * Read the file, settle anything the last quit left dangling, subscribe to
   * the engine, and start the minute tick. Never throws — a routines file
   * that cannot be read is an empty list, not a failed boot.
   */
  start(): Promise<void>;
  /**
   * The state right now, for one scope or for everyone. Cheap; built from
   * memory.
   */
  state(scope?: string): RoutinesState;
  /**
   * Create a routine. An owner pins it to a scope and a directory; without
   * one the draft's own `cwd` is required, which is the desktop's case.
   */
  create(draft: RoutineDraft, owner?: RoutineOwner): Promise<RoutinesState>;
  update(id: RoutineId, patch: RoutinePatch, scope?: string): Promise<RoutinesState>;
  remove(id: RoutineId, scope?: string): Promise<RoutinesState>;
  /**
   * Fire one routine right now, schedule and pause notwithstanding — the
   * button beside every row. Still overlap-guarded: "run it again" while it
   * is running records a skip rather than stacking a second copy.
   */
  runNow(id: RoutineId, scope?: string): Promise<RoutinesState>;
  /** Stop the tick and the subscription, for shutdown. */
  dispose(): Promise<void>;
}

export function createRoutineHost(options: RoutineHostOptions): RoutineHost {
  const configPath = join(options.dataDir, ROUTINES_CONFIG_FILE);
  const report = (message: string, error: unknown): void => options.onError?.(message, error);

  let routines: readonly Routine[] = [];
  let started = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** The minute boundary the pending timer is aimed at. */
  let aimedAt = 0;
  /** Runs this host started and is still watching, run id → routine id. */
  const liveRuns = new Map<string, RoutineId>();
  let unsubscribe: (() => void) | undefined;

  /* ----------------------------------------------------------------------- */
  /* Scope                                                                   */
  /* ----------------------------------------------------------------------- */

  /**
   * The one visibility rule. No scope asked means the host has one owner
   * and every routine is theirs; a scope asked means only routines filed
   * under it, and a routine with no scope at all belongs to nobody who asks
   * by scope — the desktop's records never answer to a server token.
   */
  function inScope(routine: Routine, scope: string | undefined): boolean {
    return scope === undefined || routine.scope === scope;
  }

  function require(id: RoutineId, scope: string | undefined): Routine {
    const routine = routines.find((entry) => entry.id === id);
    if (routine === undefined || !inScope(routine, scope)) throw new UnknownRoutineError(id);
    return routine;
  }

  /* ----------------------------------------------------------------------- */
  /* Snapshot and publish                                                    */
  /* ----------------------------------------------------------------------- */

  function snapshot(scope: string | undefined, now = Date.now()): RoutinesState {
    const running = new Set(liveRuns.values());
    return {
      routines: routines
        .filter((routine) => inScope(routine, scope))
        .map((routine): RoutineSnapshot => {
          const next = routine.paused ? undefined : nextFireAt(routine.schedule, now);
          return {
            ...routine,
            ...(next === undefined ? {} : { nextFireAt: next }),
            running: running.has(routine.id),
          };
        }),
    };
  }

  /** Publish the whole host's state, and answer with the caller's slice of it. */
  function publish(scope?: string): RoutinesState {
    options.broadcast(snapshot(undefined));
    return scope === undefined ? snapshot(undefined) : snapshot(scope);
  }

  /* ----------------------------------------------------------------------- */
  /* Persistence                                                             */
  /* ----------------------------------------------------------------------- */

  /**
   * Writes are chained, never concurrent: two overlapping writers would race
   * each other's temp file, and the loser's snapshot — not necessarily the
   * older one — would win the rename. The tick calls this un-awaited, so the
   * chain is also what keeps a slow disk from stalling the schedule.
   */
  let persisting: Promise<void> = Promise.resolve();

  function persist(): Promise<void> {
    persisting = persisting.then(async () => {
      const temp = `${configPath}.tmp`;
      try {
        await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
        // Owner-only, like its neighbours: instructions are the user's own
        // words, and words written for an agent are not for other accounts.
        await writeFile(temp, `${JSON.stringify({ routines }, null, 2)}\n`, {
          encoding: 'utf8',
          mode: 0o600,
        });
        await rename(temp, configPath);
      } catch (error) {
        // Reported, not thrown — losing an edit across a restart is a
        // nuisance; failing the click that made it is worse.
        report('Could not persist the routines', error);
      }
    });
    return persisting;
  }

  async function load(): Promise<void> {
    let stored: unknown;
    try {
      stored = JSON.parse(await readFile(configPath, 'utf8'));
    } catch {
      // Absent on first run; unreadable is recoverable. An empty list is a
      // working configuration.
      stored = null;
    }
    const record =
      typeof stored === 'object' && stored !== null ? (stored as Record<string, unknown>) : {};
    routines = readRoutines(record['routines']).map(settleDeadRuns);
  }

  /**
   * A `running` row found on disk is a run the host quit under. It is settled
   * as `interrupted` — which is what happened to it — so the history never
   * shows a spinner nothing can clear.
   */
  function settleDeadRuns(routine: Routine): Routine {
    if (!routine.history.some((row) => row.outcome === 'running')) return routine;
    return {
      ...routine,
      history: routine.history.map((row) =>
        row.outcome === 'running' ? { ...row, outcome: 'interrupted' as const } : row,
      ),
    };
  }

  /* ----------------------------------------------------------------------- */
  /* History                                                                 */
  /* ----------------------------------------------------------------------- */

  function amendRoutine(id: RoutineId, change: (routine: Routine) => Routine): void {
    routines = routines.map((routine) => (routine.id === id ? change(routine) : routine));
  }

  function recordFiring(id: RoutineId, row: RoutineRunRecord): void {
    amendRoutine(id, (routine) => ({
      ...routine,
      lastFiredAt: row.firedAt,
      history: [row, ...routine.history].slice(0, MAX_ROUTINE_HISTORY),
    }));
  }

  function amendHistory(
    id: RoutineId,
    runId: string,
    change: (row: RoutineRunRecord) => RoutineRunRecord,
  ): void {
    amendRoutine(id, (routine) => ({
      ...routine,
      history: routine.history.map((row) => (row.runId === runId ? change(row) : row)),
    }));
  }

  /* ----------------------------------------------------------------------- */
  /* Watching the runs                                                       */
  /* ----------------------------------------------------------------------- */

  /** The transcript's reasons, folded to the ledger's three verdicts. */
  function outcomeFor(reason: RunEndReason): 'completed' | 'error' | 'interrupted' {
    if (reason === 'completed') return 'completed';
    if (reason === 'interrupted' || reason === 'disposed') return 'interrupted';
    return 'error';
  }

  function onAgentEvent(event: AgentEvent): void {
    const routineId = liveRu