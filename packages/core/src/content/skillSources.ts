/**
 * Skill sources: repositories Artemis keeps cloned and pulled.
 * ============================================================================
 *
 * A person's skills are one list, and they want it on every machine they work
 * on. The way to have that without Artemis is an installer run by hand on each
 * machine and a scheduled task to keep each copy fresh — per operating system,
 * and a container has no scheduler at all, so its copy is pulled by its host.
 * This module is that arrangement made Artemis's job: name the repository once,
 * and every host that runs this code keeps a copy current by itself.
 *
 * ---------------------------------------------------------------------------
 * THE COPY IS A CACHE, SO IT IS RESET, NOT MERGED
 * ---------------------------------------------------------------------------
 *
 * The clone lives under Artemis's data directory and nobody edits it. That
 * makes the honest update `fetch` then `reset --hard` to what was fetched,
 * rather than the `pull --ff-only` a memory bank gets: a bank's clone may hold
 * work in progress and must never lose it, while this one holds nothing of
 * anyone's. Reset also survives what a fast-forward cannot — a rewritten
 * history upstream, a revert — which is exactly how a bad skill update is
 * undone, and the undo has to reach every machine.
 *
 * Shallow, because the history of a skills repository is of no use to a
 * session and a full clone of a busy one is slow on the first run.
 *
 * ---------------------------------------------------------------------------
 * A SYNC NEVER STANDS BETWEEN A PERSON AND A RUN
 * ---------------------------------------------------------------------------
 *
 * Runs read whatever copy is on disk. Syncing happens behind them — throttled,
 * so a busy hour is one fetch and not sixty — and a sync that fails leaves the
 * copy it had in place and says why. A machine that is offline keeps its
 * skills; a repository that moved keeps serving the last version it gave.
 *
 * Credentials are the machine's own: `GIT_TERMINAL_PROMPT=0` makes a missing
 * one a quick, legible failure instead of a process waiting on a prompt no one
 * will ever see, which is the rule every other git call in Artemis follows.
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { SkillSource, SkillSourceStatus } from '@rx-artemis/protocol';

import { skillFoldersIn } from './bridge.js';

const execFileAsync = promisify(execFile);

/** Where every source's clone lives, under a host's data directory. */
const SOURCES_DIR = 'skill-sources';

/** How often a source is fetched at most, however many runs start. */
export const SKILL_SOURCE_SYNC_THROTTLE_MS = 15 * 60_000;

/** A clone of a small repository; generous for a slow link, finite for a dead one. */
const GIT_TIMEOUT_MS = 120_000;

/** The clone's own folder. */
export function skillSourceCloneDir(dataDir: string, source: SkillSource): string {
  return join(dataDir, SOURCES_DIR, source.id);
}

/** The folder inside the clone that holds the skills. */
export function skillSourceSkillsDir(dataDir: string, source: SkillSource): string {
  return join(skillSourceCloneDir(dataDir, source), ...source.subdir.split(/[\\/]/));
}

/** A source's skills folder, with the id the list names it by. */
export interface SkillSourceRoot {
  readonly id: string;
  readonly dir: string;
}

export interface SkillSourceSyncResult {
  readonly ok: boolean;
  /** The copy is at a different commit than before. */
  readonly moved: boolean;
  /** The commit the copy is at, abbreviated, when it could be read. */
  readonly head?: string;
  /** One line for a log, a receipt, or the pane. */
  readonly detail: string;
}

/* -------------------------------------------------------------------------- */
/* git                                                                        */
/* -------------------------------------------------------------------------- */

async function git(
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): Promise<{ readonly ok: true; readonly stdout: string } | { readonly ok: false; readonly detail: string }> {
  try {
    const { stdout } = await execFileAsync('git', [...args], {
      timeout: GIT_TIMEOUT_MS,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
    });
    return { ok: true, stdout: stdout.trim() };
  } catch (error) {
    const raw = error as { code?: unknown; stderr?: unknown; message?: unknown };
    if (raw.code === 'ENOENT') return { ok: false, detail: 'git is not installed on this machine' };
    const said =
      typeof raw.stderr === 'string' && raw.stderr.trim().length > 0
        ? raw.stderr
        : String(raw.message ?? 'git failed');
    // Git's last line is the one that says what went wrong; the ones above it
    // are progress. The same reading `pullBank` makes.
    const last = said.split('\n').filter((line) => line.trim().length > 0).at(-1) ?? 'git failed';
    return { ok: false, detail: last.replace(/^(fatal|error):\s*/i, '').trim() };
  }
}

async function isClone(dir: string): Promise<boolean> {
  return stat(join(dir, '.git'))
    .then((info) => info.isDirectory())
    .catch(() => false);
}

async function headOf(dir: string, env: Readonly<Record<string, string>>): Promise<string | undefined> {
  const head = await git(['-C', dir, 'rev-parse', '--short', 'HEAD'], env);
  return head.ok && head.stdout.length > 0 ? head.stdout : undefined;
}

/**
 * Bring one source's copy up to its remote, cloning it if it is not there.
 *
 * Never throws. The `--` before the URL is belt and braces — the protocol's
 * `skillSourceUrlProblem` already refuses a leading hyphen — because this is
 * the one place a string from a settings file becomes an argument to a program.
 *
 * A first clone lands in a scratch folder and is renamed into place, so a clone
 * that dies half way leaves nothing that looks like a source and the next sync
 * starts clean rather than fetching into a wreck.
 */
export async function syncSkillSource(options: {
  readonly source: SkillSource;
  readonly dataDir: string;
  readonly env?: Readonly<Record<string, string>>;
}): Promise<SkillSourceSyncResult> {
  const env = options.env ?? {};
  const dir = skillSourceCloneDir(options.dataDir, options.source);

  if (!(await isClone(dir))) {
    const scratch = `${dir}.${randomUUID().slice(0, 8)}.tmp`;
    await mkdir(join(options.dataDir, SOURCES_DIR), { recursive: true });
    const cloned = await git(['clone', '--depth', '1', '--quiet', '--', options.source.url, scratch], env);
    if (!cloned.ok) {
      await rm(scratch, { recursive: true, force: true });
      return { ok: false, moved: false, detail: cloned.detail };
    }
    // Something that is not a clone may be squatting on the name — a folder a
    // failed run left, a file. It is ours to clear: nothing else writes here.
    await rm(dir, { recursive: true, force: true });
    await rename(scratch, dir);
    const head = await headOf(dir, env);
    return { ok: true, moved: true, ...(head === undefined ? {} : { head }), detail: 'cloned' };
  }

  const before = await headOf(dir, env);
  // The URL is the source's identity only after canonicalising, so the https
  // and ssh spellings share a clone — and the one in the settings file is the
  // one to fetch from, whichever the clone was made with.
  const remote = await git(['-C', dir, 'remote', 'set-url', 'origin', options.source.url], env);
  if (!remote.ok) return { ok: false, moved: false, ...(before === undefined ? {} : { head: before }), detail: remote.detail };

  const fetched = await git(['-C', dir, 'fetch', '--depth', '1', '--quiet', 'origin'], env);
  if (!fetched.ok) return { ok: false, moved: false, ...(before === undefined ? {} : { head: before }), detail: fetched.detail };

  const reset = await git(['-C', dir, 'reset', '--hard', '--quiet', 'FETCH_HEAD'], env);
  if (!reset.ok) return { ok: false, moved: false, ...(before === undefined ? {} : { head: before }), detail: reset.detail };

  const after = await headOf(dir, env);
  const moved = after !== undefined && after !== before;
  return {
    ok: true,
    moved,
    ...(after === undefined ? {} : { head: after }),
    detail: moved ? `moved to ${after}` : 'already up to date',
  };
}

/* -------------------------------------------------------------------------- */
/* A host's sources                                                           */
/* -------------------------------------------------------------------------- */

export interface SkillSourcesOptions {
  /** The host's data directory; clones live beneath it. */
  readonly dataDir: string;
  /** Extra environment for git. Read per call, so a credential can be short-lived. */
  readonly env?: () => Readonly<Record<string, string>>;
  /** Defaults to {@link SKILL_SOURCE_SYNC_THROTTLE_MS}. */
  readonly throttleMs?: number;
  /** Clock, injectable for tests. */
  readonly now?: () => number;
  /** Where a failed background sync is reported. */
  readonly onWarning?: (message: string) => void;
}

/** One host's view of its sources: where they are, how they are, keeping them fresh. */
export interface SkillSources {
  /** The folders a session is offered skills from, for the content bridge. */
  roots(sources: readonly SkillSource[]): readonly SkillSourceRoot[];
  /** How each source's copy is doing right now. */
  status(sources: readonly SkillSource[]): Promise<readonly SkillSourceStatus[]>;
  /**
   * Sync one source. Throttled unless `force` — "Pull now" forces, a run
   * starting does not — and a sync already in flight is joined, not doubled.
   */
  sync(source: SkillSource, options?: { readonly force?: boolean }): Promise<SkillSourceSyncResult>;
  /** Sync whatever is due, behind the caller. Returns at once; never rejects. */
  syncInBackground(sources: readonly SkillSource[]): void;
  /** Delete a source's copy. The folder is this module's own. */
  remove(source: SkillSource): Promise<void>;
}

export function createSkillSources(options: SkillSourcesOptions): SkillSources {
  const now = options.now ?? (() => Date.now());
  const throttleMs = options.throttleMs ?? SKILL_SOURCE_SYNC_THROTTLE_MS;
  const gitEnv = (): Readonly<Record<string, string>> => options.env?.() ?? {};

  /** Per source id: when it was last attempted, and how the last attempt went. */
  const attempts = new Map<string, { at: number; syncedAt?: number; error?: string }>();
  const inFlight = new Map<string, Promise<SkillSourceSyncResult>>();

  const sync: SkillSources['sync'] = (source, syncOptions) => {
    const running = inFlight.get(source.id);
    if (running) return running;

    const last = attempts.get(source.id);
    if (syncOptions?.force !== true && last !== undefined && now() - last.at < throttleMs) {
      return Promise.resolve({ ok: last.error === undefined, moved: false, detail: last.error ?? 'synced recently' });
    }

    // Stamped before the work rather than after, so a second caller arriving
    // while a slow clone runs is throttled by this attempt and not by the last.
    attempts.set(source.id, { at: now(), ...(last?.syncedAt === undefined ? {} : { syncedAt: last.syncedAt }) });
    const run = syncSkillSource({ source, dataDir: options.dataDir, env: gitEnv() })
      .then((result) => {
        const previous = attempts.get(source.id);
        attempts.set(source.id, {
          at: previous?.at ?? now(),
          ...(result.ok
            ? { syncedAt: now() }
            : { ...(previous?.syncedAt === undefined ? {} : { syncedAt: previous.syncedAt }), error: result.detail }),
        });
        return result;
      })
      .finally(() => {
        inFlight.delete(source.id);
      });
    inFlight.set(source.id, run);
    return run;
  };

  return {
    roots: (sources) =>
      sources.map((source) => ({ id: source.id, dir: skillSourceSkillsDir(options.dataDir, source) })),

    status: async (sources) =>
      Promise.all(
        sources.map(async (source): Promise<SkillSourceStatus> => {
          const dir = skillSourceCloneDir(options.dataDir, source);
          const cloned = await isClone(dir);
          const attempt = attempts.get(source.id);
          // After a restart nothing is remembered, and the honest "last synced"
          // is when git last wrote what it fetched — or, for a copy never
          // fetched into, when it was cloned.
          const onDisk = cloned
            ? await stat(join(dir, '.git', 'FETCH_HEAD'))
                .catch(() => stat(join(dir, '.git', 'HEAD')))
                .then((info) => Math.round(info.mtimeMs))
                .catch(() => undefined)
            : undefined;
          const syncedAt = attempt?.syncedAt ?? onDisk;
          const head = cloned ? await headOf(dir, gitEnv()) : undefined;
          return {
            source,
            cloned,
            ...(head === undefined ? {} : { head }),
            ...(syncedAt === undefined ? {} : { syncedAt }),
            ...(attempt?.error === undefined ? {} : { error: attempt.error }),
            skillCount: cloned ? (await skillFoldersIn(skillSourceSkillsDir(options.dataDir, source))).length : 0,
          };
        }),
      ),

    sync,

    syncInBackground: (sources) => {
      for (const source of sources) {
        void sync(source)
          .then((result) => {
            if (!result.ok) options.onWarning?.(`Could not sync the skills from ${source.url}: ${result.detail}`);
          })
          .catch(() => undefined);
      }
    },

    remove: async (source) => {
      attempts.delete(source.id);
      await rm(skillSourceCloneDir(options.dataDir, source), { recursive: true, force: true });
    },
  };
}
