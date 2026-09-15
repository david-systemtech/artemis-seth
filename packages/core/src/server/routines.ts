/**
 * Routines that live and fire *in the server*.
 * ============================================================================
 *
 * The desktop keeps its own appointments in `apps/desktop/main/routines.ts`; a
 * routine there fires only while that app is running. This is the other place a
 * routine can live: inside a server, so it fires on schedule with every client
 * closed — the whole point of "runs unattended when the laptop is shut". It is
 * a close copy of the desktop host, moved into core with the Electron seams
 * replaced by injected ones, because the two must keep the same promises:
 *
 *  - **A firing is an ordinary run.** Each due minute starts a run through the
 *    server's own {@link RunSource} — same transcript, same session history the
 *    session routes then list — tagged with `metadata.routineId` so its firings
 *    can be found again.
 *  - **Overlap is guarded.** "Run it again" while a firing is still going
 *    records a skip rather than stacking a second copy.
 *  - **Sleep is made up once.** A server that was down over an appointment
 *    fires the newest missed one on the next tick and lets the rest go, bounded
 *    by the same seven-day window the desktop uses.
 *
 * ## What is different from the desktop, and why
 *
 * **Every routine is owned.** A server serves several clients, so a routine
 * carries the same `workspaceKey` the session ledger scopes conversations by
 * (`scope`) and the connection that created it (`connectionId`). A token sees,
 * edits and fires exactly the routines whose `scope` matches its own — the rule
 * the wire routes enforce and this store is written to make enforceable.
 *
 * **The directory is pinned, never chosen.** A served run may only start in the
 * connection's own workspace — the same rule completions obey — so a firing
 * resolves the connection's directory afresh (it may have moved or been
 * deleted) and runs there, ignoring anything stored. A routine whose connection
 * is gone, or whose folder has vanished, records a skip rather than running
 * somewhere it should not.
 *
 * **The mode is bypass by default.** A server has no one in front of it, and
 * the permission-park deadline that used to deny an unanswered prompt has been
 * removed — so a non-bypass server routine would park on its first prompt with
 * nobody to answer, forever. A firing therefore opens in the routine's mode or,
 * when it set none, `bypassPermissions`, which is what the form stores for a
 * server routine and what lets unattended work get past a prompt.
 *
 * ## Deliberately not HTTP-aware
 *
 * This is a store and a scheduler and nothing else: it takes a `RunSource`, a
 * `WorkspaceResolver`, a catalogue read and a connection list, and answers
 * scope-checked calls. The routes in `http.ts` are the only thing that knows a
 * request from a token — they resolve the scope and hand it here.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

import type {
  AgentEvent,
  PermissionMode,
  ProfileId,
  ProviderId,
  Routine,
  RoutineDraft,
  RoutineId,
  RoutinePatch,
  RoutineRunRecord,
  RoutineSchedule,
  RoutineSkipReason,
  RoutineSnapshot,
  RunEndReason,
  RunHandle,
  RunId,
  RunInput,
  ServerConnection,
} from '@rx-artemis/protocol';
import {
  isPermissionMode,
  isProviderId,
  lastFireBetween,
  MAX_ROUTINE_HISTORY,
  nextFireAt,
  scheduleMatchesMinute,
  scheduleProblem,
} from '@rx-artemis/protocol';

import type { Catalogue } from './catalogue.js';
import { workspaceKeyFor } from './ledger.js';
import { WorkspaceUnavailableError, type WorkspaceResolver } from './workspaces.js';

/** Beside `serverSessions.json` and the rest of the server's own records. */
export const SERVER_ROUTINES_FILE = 'serverRoutines.json';

/**
 * A tick that lands this much later than the minute it was aimed at is a
 * machine that was asleep (or a container that was paused), and the catch-up
 * pass runs. The desktop host's own threshold, for the same reason.
 */
const SLEEP_GAP_MS = 90_000;

/**
 * The slice of the engine one firing needs.
 *
 * Narrower than {@link RunSource} on purpose: this store starts runs and
 * watches them settle, and needs nothing else. It is wired from a host's
 * `startUserRun` — a routine is the connection owner's own scheduled work, so
 * it is started with the whole {@link RunInput} (metadata and mode and all),
 * the same entry point the remote bridge uses for a person's own runs.
 */
export interface ServerRoutineRuns {
  /** Start a run and resolve once it is registered. Honours `input.runId`. */
  start(input: RunInput): Promise<RunHandle>;
  /** Every event from every run. Filtered by `runId` here. */
  subscribe(listener: (event: AgentEvent) => void): () => void;
}

export interface ServerRoutineStoreOptions {
  /** The server's data directory — where {@link SERVER_ROUTINES_FILE} lives. */
  readonly dataDir: string;
  /** How firings are started and watched. See {@link ServerRoutineRuns}. */
  readonly runs: ServerRoutineRuns;
  /** Where a firing's directory is resolved, exactly as a completion's is. */
  readonly workspaces: WorkspaceResolver;
  /** The served accounts, for resolving a routine's default model. */
  readonly catalogue: Catalogue;
  /**
   * The configured connections, read live. A firing looks up its own
   * connection here to learn *where* it runs — a routine outlives the request
   * that made it, and the connection it belongs to may have been revoked or
   * re-pointed since.
   */
  readonly connections: () => readonly ServerConnection[];
  /** Clock, injectable so a test can move time without waiting. */
  readonly now?: () => number;
  /**
   * The tick interval, in ms. Defaults to a real minute. A test passes `0` to
   * suppress the timer and drive {@link ServerRoutineStore.tick} itself.
   */
  readonly tickMs?: number;
}

export interface ServerRoutineStore {
  /** Read the file and settle anything a dead process left dangling. */
  load(): Promise<void>;
  /** Begin the minute tick, after a catch-up pass over what was missed while down. */
  start(): void;
  /** Routines a connection with this workspace key owns, newest first, as snapshots. */
  listFor(workspaceKey: string): readonly RoutineSnapshot[];
  /**
   * Create a routine owned by a connection. The caller's scope and id are
   * stamped on; a client-sent `cwd` is ignored, because a served firing may
   * only run in the connection's own workspace.
   *
   * @throws when the draft is unusable, or the connection has no directory to
   *   pin the routine to.
   */
  create(input: {
    readonly draft: RoutineDraft;
    readonly connection: ServerConnection;
  }): Promise<RoutineSnapshot>;
  /** Edit a routine this scope owns. `undefined` when it owns no such routine. */
  update(
    workspaceKey: string,
    id: RoutineId,
    patch: RoutinePatch,
  ): Promise<RoutineSnapshot | undefined>;
  /** Delete a routine this scope owns. False when it owns no such routine. */
  remove(workspaceKey: string, id: RoutineId): Promise<boolean>;
  /** Fire a routine this scope owns now. `undefined` when it owns no such routine. */
  runNow(workspaceKey: string, id: RoutineId): Promise<RoutineSnapshot | undefined>;
  /** Run the tick once. For tests; the timer calls it live. */
  tick(): Promise<void>;
  /** Stop the tick and the subscription, and flush the write chain. */
  dispose(): Promise<void>;
}

export function createServerRoutineStore(
  options: ServerRoutineStoreOptions,
): ServerRoutineStore {
  const configPath = join(options.dataDir, SERVER_ROUTINES_FILE);
  const now = options.now ?? (() => Date.now());
  const tickMs = options.tickMs ?? 60_000;

  let routines: readonly Routine[] = [];
  let started = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** The minute boundary the pending timer is aimed at. */
  let aimedAt = 0;
  /** Runs this store started and is still watching, run id → routine id. */
  const liveRuns = new Map<string, RoutineId>();
  let unsubscribe: (() => void) | undefined;

  /* ----------------------------------------------------------------------- */
  /* Snapshots                                                               */
  /* ----------------------------------------------------------------------- */

  function snapshotOf(routine: Routine, at = now()): RoutineSnapshot {
    const next = routine.paused ? undefined : nextFireAt(routine.schedule, at);
    const running = [...liveRuns.values()].includes(routine.id);
    return {
      ...routine,
      ...(next === undefined ? {} : { nextFireAt: next }),
      running,
    };
  }

  /* ----------------------------------------------------------------------- */
  /* Persistence                                                             */
  /* ----------------------------------------------------------------------- */

  /**
   * Writes are chained, never concurrent — two overlapping writers would race
   * the same temp file and the loser's snapshot would win the rename. The tick
   * writes un-awaited, so the chain is also what keeps a slow disk from
   * stalling the schedule.
   */
  let persisting: Promise<void> = Promise.resolve();

  function persist(): Promise<void> {
    persisting = persisting.then(async () => {
      const temp = `${configPath}.tmp`;
      try {
        await mkdir(dirname(configPath), { recursive: true });
        await writeFile(temp, `${JSON.stringify({ routines }, null, 2)}\n`, 'utf8');
        await rename(temp, configPath);
      } catch {
        // Losing an edit across a restart is a nuisance; failing the request
        // that made it is worse. The next change tries again.
      }
    });
    return persisting;
  }

  async function load(): Promise<void> {
    let stored: unknown;
    try {
      stored = JSON.parse(await readFile(configPath, 'utf8'));
    } catch {
      // Absent on first run, unreadable is recoverable. An empty list works.
      stored = null;
    }
    const record =
      typeof stored === 'object' && stored !== null ? (stored as Record<string, unknown>) : {};
    routines = readServerRoutines(record['routines']).map(settleDeadRuns);
  }

  /**
   * A `running` row found on disk is a run the process died under. Settled as
   * `interrupted`, which is what happened to it, so history never shows a
   * spinner nothing can clear.
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

  /** The engine's end reasons, folded to the ledger's three verdicts. */
  function outcomeFor(reason: RunEndReason): 'completed' | 'error' | 'interrupted' {
    if (reason === 'completed') return 'completed';
    if (reason === 'interrupted' || reason === 'disposed') return 'interrupted';
    return 'error';
  }

  function onAgentEvent(event: AgentEvent): void {
    const routineId = liveRuns.get(String(event.runId));
    if (routineId === undefined) return;

    // Any event may carry the session id, and adapters differ on which does.
    const sessionId = (event as { sessionId?: unknown }).sessionId;
    if (typeof sessionId === 'string') {
      amendHistory(routineId, String(event.runId), (row) =>
        row.sessionId === sessionId ? row : { ...row, sessionId },
      );
    }

    if (event.type !== 'run.end') return;
    liveRuns.delete(String(event.runId));

    const outcome = outcomeFor(event.reason);
    amendHistory(routineId, String(event.runId), (row) => ({
      ...row,
      outcome,
      ...(event.reason === 'completed' ? {} : { endReason: event.reason }),
    }));
    void persist();
  }

  /* ----------------------------------------------------------------------- */
  /* Firing                                                                  */
  /* ----------------------------------------------------------------------- */

  /** Is a run for this routine still going? Asked of memory, not the engine —
   * `liveRuns` is written before the first await, so the guard cannot race a
   * firing this store started, and nothing else starts these runs. */
  function isRunning(id: RoutineId): boolean {
    return [...liveRuns.values()].includes(id);
  }

  function recordSkip(id: RoutineId, firedAt: number, reason: RoutineSkipReason): void {
    recordFiring(id, { firedAt, outcome: 'skipped', skipReason: reason });
  }

  /**
   * Where this routine's connection may run a turn, right now.
   *
   * Re-resolved on every firing rather than trusted from creation, exactly as
   * the completions route re-resolves its workspace: the folder was chosen once
   * and may have moved or been deleted, and the connection itself may have been
   * revoked. `undefined` means "do not run" — a routine with nowhere to run is
   * a skip, never a run somewhere it should not be.
   */
  async function resolveCwd(routine: Routine): Promise<string | undefined> {
    const connection = options.connections().find((entry) => entry.id === routine.connectionId);
    if (connection === undefined) return undefined;
    try {
      const resolved = await options.workspaces.resolve({
        connectionId: connection.id,
        workspace: connection.workspace,
      });
      return resolved.path;
    } catch (error) {
      // A `none` workspace, or a directory the user has since deleted — both
      // are `WorkspaceUnavailableError`. Anything else is unexpected but leads
      // to the same place: no directory, no run.
      void (error instanceof WorkspaceUnavailableError);
      return undefined;
    }
  }

  /**
   * The model a firing runs. The routine's own when it named one, otherwise the
   * account's default — the first route the catalogue publishes for it, which
   * is what an omitted model resolves to everywhere else. `undefined` only when
   * the account has vanished from the catalogue, which is itself a reason not
   * to fire.
   */
  async function resolveModel(routine: Routine): Promise<string | undefined> {
    if (routine.model !== undefined) return routine.model;
    try {
      const profiles = await options.catalogue.read({});
      const profile = profiles.find((entry) => String(entry.id) === String(routine.profileId));
      return profile?.models[0]?.id;
    } catch {
      return undefined;
    }
  }

  async function fire(routine: Routine, firedAt: number, catchUp: boolean): Promise<void> {
    if (isRunning(routine.id)) {
      recordSkip(routine.id, firedAt, 'overlap');
      return;
    }

    const cwd = await resolveCwd(routine);
    const model = await resolveModel(routine);
    if (cwd === undefined || model === undefined) {
      // Nowhere to run, or no model to run — either way the firing cannot be
      // started, which is the same shape as an unavailable engine.
      recordSkip(routine.id, firedAt, 'engine-unavailable');
      return;
    }

    // Minted here, and passed as `RunInput.runId`, so the live-run map and the
    // history row exist *before* the first event can arrive — the overlap guard
    // reads memory, and the guard must be true the instant a firing begins.
    const runId = `server-routine-${routine.id}-${String(firedAt)}` as RunId;
    liveRuns.set(String(runId), routine.id);
    recordFiring(routine.id, {
      firedAt,
      runId: String(runId),
      outcome: 'running',
      ...(catchUp ? { catchUp: true } : {}),
    });

    try {
      await options.runs.start({
        providerId: routine.providerId,
        profileId: routine.profileId as ProfileId,
        cwd,
        prompt: routine.instructions,
        runId,
        model,
        ...(routine.effort === undefined ? {} : { effort: routine.effort }),
        // A firing nobody is watching opens in bypass unless the routine
        // explicitly asked for something stricter — see the file comment on why
        // any other mode would park forever on this surface.
        permissionMode: routine.permissionMode ?? 'bypassPermissions',
        metadata: { routineId: routine.id, firedAt, ...(catchUp ? { catchUp: true } : {}) },
      });
    } catch {
      // The run never started, so no `run.end` will settle the row.
      liveRuns.delete(String(runId));
      amendHistory(routine.id, String(runId), (row) => ({
        ...row,
        outcome: 'error',
        endReason: 'error',
      }));
    }
  }

  /* ----------------------------------------------------------------------- */
  /* The tick                                                                */
  /* ----------------------------------------------------------------------- */

  function nextBoundary(from: number): number {
    return Math.floor(from / 60_000) * 60_000 + 60_000;
  }

  function schedule(): void {
    if (stopped || tickMs <= 0) return;
    if (timer !== undefined) clearTimeout(timer);
    const at = now();
    aimedAt = nextBoundary(at);
    // A moment past the boundary, so the tick's own date is inside the minute
    // it is deciding about rather than on its edge.
    timer = setTimeout(() => void tick(), aimedAt - at + 250);
    timer.unref?.();
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    const at = now();
    const minute = new Date(nextBoundary(at) - 60_000);

    // Woke up late: the server was down or paused through one or more
    // boundaries. Make up the newest missed appointment per routine, then fall
    // through to the ordinary check for the minute we landed in.
    if (at - aimedAt >= SLEEP_GAP_MS) {
      await catchUp(minute);
    }

    let acted = false;
    // Id order, the same order every tick, so routines that share a minute
    // always fire in the same sequence.
    for (const routine of [...routines].sort((a, b) => a.id.localeCompare(b.id))) {
      if (routine.paused) continue;
      if (!scheduleMatchesMinute(routine.schedule, minute)) continue;
      await fire(routine, at, false);
      acted = true;
    }
    if (acted) void persist();
    schedule();
  }

  /**
   * The one make-up firing per routine after the server was down: the newest
   * appointment missed since the routine last acted — bounded by the seven-day
   * window inside `lastFireBetween` — fired once, the rest let go. A routine
   * whose schedule names the current minute is skipped here; the fresh firing
   * about to happen *is* its catch-up.
   */
  async function catchUp(currentMinute: Date): Promise<void> {
    const before = currentMinute.getTime() - 1;
    let acted = false;
    for (const routine of [...routines].sort((a, b) => a.id.localeCompare(b.id))) {
      if (routine.paused) continue;
      if (scheduleMatchesMinute(routine.schedule, currentMinute)) continue;
      const baseline = routine.lastFiredAt ?? routine.createdAt;
      const missed = lastFireBetween(routine.schedule, baseline, before);
      if (missed === undefined) continue;
      await fire(routine, now(), true);
      acted = true;
    }
    if (acted) void persist();
  }

  /* ----------------------------------------------------------------------- */
  /* The scope-checked surface                                               */
  /* ----------------------------------------------------------------------- */

  /** A routine this workspace key owns, or `undefined`. The one gate the routes
   * authorise against — "not yours" and "not there" are one answer here too. */
  function owned(workspaceKey: string, id: RoutineId): Routine | undefined {
    const routine = routines.find((entry) => entry.id === id);
    return routine !== undefined && routine.scope === workspaceKey ? routine : undefined;
  }

  return {
    load,

    start() {
      if (started) return;
      started = true;
      unsubscribe = options.runs.subscribe(onAgentEvent);
      /*
       * A boot is a wake: the server may have been down over any number of
       * appointments. `lastFiredAt` bounds the search, so this fires at most
       * one make-up per routine. The horizon is the *next* boundary, not the
       * current minute, so an appointment in the minute the process happened to
       * start in belongs to the first tick or to nobody.
       */
      void catchUp(new Date(nextBoundary(now()))).then(() => {
        if (!stopped) schedule();
      });
    },

    listFor(workspaceKey) {
      const at = now();
      return routines
        .filter((routine) => routine.scope === workspaceKey)
        .map((routine) => snapshotOf(routine, at))
        // Newest first, the same order the session surface lists in.
        .sort((a, b) => b.createdAt - a.createdAt);
    },

    async create({ draft, connection }) {
      /*
       * A server routine runs in the connection's own directory, so the
       * connection must have one. An ephemeral or catalogue-only connection has
       * nowhere to pin an unattended appointment — refused loudly here rather
       * than at 3am when the first firing finds no folder.
       */
      if (connection.workspace.kind !== 'directory') {
        throw new Error(
          'This connection has no fixed directory, so it cannot own a routine — a scheduled run needs a folder to start in.',
        );
      }
      const routine = readServerRoutine({
        ...draft,
        // The client's `cwd` is ignored — the pin is the connection's, and the
        // resolved directory is re-read on every firing anyway. Stored for
        // display, so a listing shows where firings land.
        cwd: connection.workspace.path,
        id: randomBytes(8).toString('base64url'),
        scope: workspaceKeyFor(connection),
        connectionId: connection.id,
        paused: draft.paused === true,
        createdAt: now(),
        history: [],
      });
      if (routine === undefined) {
        throw new Error('The routine draft is not usable.');
      }
      routines = [...routines, routine];
      await persist();
      return snapshotOf(routine);
    },

    async update(workspaceKey, id, patch) {
      const existing = owned(workspaceKey, id);
      if (existing === undefined) return undefined;
      amendRoutine(id, (routine) => {
        const merged = readServerRoutine({
          ...routine,
          ...(patch.name === undefined ? {} : { name: patch.name }),
          ...(patch.instructions === undefined ? {} : { instructions: patch.instructions }),
          // `cwd`, `scope`, `connectionId` and `profileId`/`providerId` are the
          // routine's identity as a *server* routine and are not the client's
          // to move — a patch that named them would be re-homing someone's
          // appointment, so they are left exactly as they were.
          ...(patch.model === undefined
            ? {}
            : patch.model === ''
              ? { model: undefined }
              : { model: patch.model }),
          ...(patch.effort === undefined
            ? {}
            : patch.effort === ''
              ? { effort: undefined }
              : { effort: patch.effort }),
          ...(patch.permissionMode === undefined ? {} : { permissionMode: patch.permissionMode }),
          ...(patch.schedule === undefined ? {} : { schedule: patch.schedule }),
          ...(patch.paused === undefined ? {} : { paused: patch.paused }),
        });
        return merged ?? routine;
      });
      await persist();
      const after = routines.find((routine) => routine.id === id);
      return after === undefined ? undefined : snapshotOf(after);
    },

    async remove(workspaceKey, id) {
      if (owned(workspaceKey, id) === undefined) return false;
      routines = routines.filter((routine) => routine.id !== id);
      await persist();
      return true;
    },

    async runNow(workspaceKey, id) {
      const routine = owned(workspaceKey, id);
      if (routine === undefined) return undefined;
      await fire(routine, now(), false);
      await persist();
      const after = routines.find((entry) => entry.id === id);
      return after === undefined ? undefined : snapshotOf(after);
    },

    tick,

    async dispose() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      unsubscribe?.();
      unsubscribe = undefined;
      // Flush the write chain: the tick persists un-awaited, and stopping
      // between the rename and the write would hand the next start a ledger
      // missing the firing that just happened.
      await persisting;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Reading the file                                                           */
/* -------------------------------------------------------------------------- */

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Validate-and-rebuild one schedule. The same tolerant reader the desktop host
 * uses, kept here rather than shared because core cannot import the desktop and
 * the math it defers to (`scheduleProblem`) is the protocol's own.
 */
function readServerSchedule(value: unknown): RoutineSchedule | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const kind = record['kind'];

  let schedule: RoutineSchedule | undefined;
  if (kind === 'manual') schedule = { kind: 'manual' };
  else if (kind === 'hourly' && typeof record['minute'] === 'number') {
    schedule = { kind: 'hourly', minute: record['minute'] };
  } else if ((kind === 'daily' || kind === 'weekdays') && typeof record['at'] === 'string') {
    schedule = { kind, at: record['at'] };
  } else if (
    kind === 'weekly' &&
    typeof record['day'] === 'number' &&
    typeof record['at'] === 'string'
  ) {
    schedule = { kind: 'weekly', day: record['day'], at: record['at'] };
  } else if (
    kind === 'days' &&
    Array.isArray(record['days']) &&
    record['days'].every((day): day is number => typeof day === 'number') &&
    typeof record['at'] === 'string'
  ) {
    schedule = { kind: 'days', days: record['days'], at: record['at'] };
  } else if (
    kind === 'monthly' &&
    typeof record['day'] === 'number' &&
    typeof record['at'] === 'string'
  ) {
    schedule = { kind: 'monthly', day: record['day'], at: record['at'] };
  } else if (kind === 'cron' && typeof record['expression'] === 'string') {
    schedule = { kind: 'cron', expression: record['expression'] };
  }

  if (schedule === undefined || scheduleProblem(schedule) !== null) return undefined;
  return schedule;
}

const OUTCOMES = new Set(['running', 'completed', 'error', 'interrupted', 'skipped']);
const SKIP_REASONS = new Set(['overlap', 'paused', 'engine-unavailable']);

function readHistory(value: unknown): readonly RoutineRunRecord[] {
  if (!Array.isArray(value)) return [];
  const rows: RoutineRunRecord[] = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue;
    const record = raw as Record<string, unknown>;
    const firedAt = record['firedAt'];
    const outcome = record['outcome'];
    if (typeof firedAt !== 'number' || typeof outcome !== 'string' || !OUTCOMES.has(outcome)) {
      continue;
    }
    const skipReason = record['skipReason'];
    rows.push({
      firedAt,
      outcome: outcome as RoutineRunRecord['outcome'],
      ...(asString(record['runId']) === undefined ? {} : { runId: asString(record['runId']) }),
      ...(asString(record['sessionId']) === undefined
        ? {}
        : { sessionId: asString(record['sessionId']) }),
      ...(typeof skipReason === 'string' && SKIP_REASONS.has(skipReason)
        ? { skipReason: skipReason as RoutineSkipReason }
        : {}),
      ...(asString(record['endReason']) === undefined
        ? {}
        : { endReason: asString(record['endReason']) }),
      ...(record['catchUp'] === true ? { catchUp: true } : {}),
    });
    if (rows.length >= MAX_ROUTINE_HISTORY) break;
  }
  return rows;
}

/**
 * Validate-and-rebuild one server routine. A row that cannot be read is dropped
 * rather than repaired, the same rule the ledger applies to its entries: a
 * repaired guess about *whose* routine bills *whose* account is worse than a
 * lost row.
 *
 * Unlike the desktop's reader, `cwd` need not be absolute — a server routine's
 * directory is the connection's and is re-resolved on every firing — but the
 * two server-only fields are required, because a routine with no `scope` is one
 * no token could ever see and no firing could ever place.
 */
function readServerRoutine(value: unknown): Routine | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;

  const id = asString(record['id']);
  const name = asString(record['name']);
  const instructions = asString(record['instructions']);
  const profileId = asString(record['profileId']);
  const providerId = record['providerId'];
  const scope = asString(record['scope']);
  const connectionId = asString(record['connectionId']);
  const schedule = readServerSchedule(record['schedule']);
  const createdAt = record['createdAt'];
  // Stored for display and required by the record type; a server firing does
  // not trust it. Absent is read as empty rather than dropping the routine.
  const cwd = typeof record['cwd'] === 'string' ? record['cwd'] : '';

  if (
    id === undefined ||
    name === undefined ||
    instructions === undefined ||
    profileId === undefined ||
    !isProviderId(providerId) ||
    scope === undefined ||
    connectionId === undefined ||
    schedule === undefined ||
    typeof createdAt !== 'number'
  ) {
    return undefined;
  }

  const lastFiredAt = record['lastFiredAt'];
  return {
    id,
    name,
    instructions,
    cwd,
    profileId,
    providerId: providerId as ProviderId,
    ...(asString(record['model']) === undefined ? {} : { model: asString(record['model']) }),
    ...(asString(record['effort']) === undefined ? {} : { effort: asString(record['effort']) }),
    ...(isPermissionMode(record['permissionMode'])
      ? { permissionMode: record['permissionMode'] as PermissionMode }
      : {}),
    schedule,
    paused: record['paused'] === true,
    createdAt,
    scope,
    connectionId,
    ...(typeof lastFiredAt === 'number' ? { lastFiredAt } : {}),
    history: readHistory(record['history']),
  };
}

/** Every readable server routine in the stored list. Malformed rows are dropped. */
export function readServerRoutines(value: unknown): readonly Routine[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: Routine[] = [];
  for (const raw of value) {
    const routine = readServerRoutine(raw);
    if (routine === undefined || seen.has(routine.id)) continue;
    seen.add(routine.id);
    result.push(routine);
  }
  return result;
}
