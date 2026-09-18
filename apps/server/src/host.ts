/**
 * The headless composition root: core's parts, assembled without a window.
 *
 * The desktop app's `engine.ts` wires the same parts and then keeps going —
 * terminals, browsers, updaters, session naming, a prompt library, an IPC
 * surface. None of that exists here, and the absence is the design: this
 * process serves HTTP turns and stored history, so it composes exactly the
 * six calls the server's `RunSource` and `SessionSource` make, plus the
 * catalogue those calls are routed by.
 *
 * What a headless deployment gives up, stated rather than implied:
 *
 *  - **No session naming.** The desktop titles new conversations with a model
 *    call; here a session lists under its first prompt. Cosmetic.
 *  - **No prompt library of its own.** A served run's standing instructions
 *    are the client's, carried on the wire; what this process adds is the
 *    memory-bank prompt for the banks *this* machine carries, composed from
 *    this machine's own registry — see `withMemoryBanks` below, which every
 *    path that starts a run goes through, and `memoryBanks.ts`, which keeps
 *    those banks installed and fresh without anybody's cron.
 *  - **No plan-usage polling, no update checks, no notifications.** All
 *    window furniture.
 *  - **Permission prompts on the completions surface are auto-denied**, exactly
 *    as they are for the desktop-hosted server: an HTTP chat request has nobody
 *    behind it to ask. That is no longer the whole story. A *remote bridge*
 *    client (ADR 0004) is a person at another machine, and this process serves
 *    them the control routes — so a prompt raised by a bridge-started run is
 *    answered by whoever is holding that window, over the event stream. Serve
 *    profiles whose settings pre-authorize what their unattended work needs;
 *    attended work no longer has to.
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  AgentEvent,
  PlanUsage,
  ProfileId,
  ProviderId,
  RunId,
  RunInput,
  ServerConnection,
  ServerMemoryBankScope,
  SessionDelegatedWork,
} from '@rx-artemis/protocol';
import { applyPlanLimit, mergePlanUsage } from '@rx-artemis/protocol';
import {
  RunError,
  buildContentBridge,
  checkAuthStatus,
  createCatalogue,
  createDefaultProviderRegistry,
  createPushFeed,
  createRemoteRunGuard,
  createServerRoutineStore,
  createSessionLedger,
  createWorkspaceResolver,
  discoverMarketplacePlugins,
  joinSystemPromptAppends,
  linkSkillsIntoCodexHome,
  machineBankPrompt,
  managedEnvKeys,
  memoryToolServer,
  registryPath,
  MEMORY_TOOL_SERVER,
  DuplicateProfileLabelError,
  ProfileStore,
  resolveEnv,
  RunRegistry,
  SessionLifecycleLog,
  SESSION_LIFECYCLE_LOG_FILE,
  type Catalogue,
  type CommandSource,
  type MemoryBankAdmin,
  type ProfileAdmin,
  type ProviderRegistry,
  type PushFeed,
  type RemoteAccessEvent,
  type RemoteRunGuard,
  type RunSource,
  type ServerProfileRecord,
  type ServerRoutineStore,
  type SessionLedger,
  type SessionSource,
  type UsageSource,
  type WorkspaceResolver,
  takesHostToolServers,
} from '@rx-artemis/core';

import {
  createServerMemoryBanks,
  mergeBankDirectories,
  withSystemPromptAppended,
} from './memoryBanks.js';
import { createFileProfileSecrets } from './secrets.js';

/**
 * The longest title a rename stores, matching the desktop's own cap so a
 * conversation renamed over the wire and one renamed locally obey the same
 * rule.
 */
const MAX_SESSION_TITLE = 200;

/**
 * How long a slash-command reading is answered from memory.
 *
 * The reading opens the provider's CLI and asks it — a control call, never a
 * turn — which is a second or two this process should not spend on every
 * settle of every client's composer. A minute is long enough that a busy
 * connection is answered from memory and short enough that a skill dropped
 * into the container shows up in the next menu rather than the next release.
 */
const COMMAND_CACHE_MS = 60_000;

/** The providers this host hands its tool servers to — core's list, shared with the desktop. */
const takesHostTools = takesHostToolServers;

export interface HeadlessHost {
  readonly profiles: ProfileStore;
  readonly providers: ProviderRegistry;
  readonly runs: RunRegistry;
  readonly catalogue: Catalogue;
  readonly workspaces: WorkspaceResolver;
  readonly ledger: SessionLedger;
  readonly runSource: RunSource;
  readonly sessionSource: SessionSource;
  readonly usageSource: UsageSource;
  /**
   * What `GET /api/v0/commands` answers through: the slash commands a session
   * on one served account would offer, this machine's skills among them.
   * Read with the same plugins a run here is given, so the two agree.
   */
  readonly commandSource: CommandSource;
  /**
   * Routines that fire *in this server*, on schedule, with every client closed.
   *
   * The half of the routines feature that only a server can offer: the desktop
   * fires appointments while it is open, and this fires them whether or not
   * anything is watching. Scoped per connection exactly as the session ledger
   * is — see `server/routines.ts` in core.
   */
  readonly routines: ServerRoutineStore;
  /** What the account-administration routes act through. See `signin.ts`. */
  readonly profileAdmin: ProfileAdmin;
  /**
   * What the memory-bank routes act through: the registry this process keeps,
   * read and rescoped over the wire. See `memoryBanks.ts`.
   */
  readonly memoryBankAdmin: MemoryBankAdmin;
  /** Every push the server can stream to a remote client. See `server/feed.ts`. */
  readonly feed: PushFeed;
  /** Interrupt-on-disconnect for bridge-started runs. See `server/guard.ts`. */
  readonly guard: RemoteRunGuard;
  /**
   * The attribution record: which token did what.
   *
   * The headless deployment is the one this matters most for. A desktop server
   * has a person in front of it who can watch a run appear; this process is
   * reached only over the wire, by tokens, and "which of these four started
   * that" has no other answer. Ids and event names only — see
   * `RemoteAccessEvent` — into the same append-only JSONL file the run
   * lifecycle goes into, beside the ledger in the data directory.
   */
  readonly recordAccess: (event: RemoteAccessEvent) => void;
  dispose(): Promise<void>;
}

export function createHeadlessHost(
  dataDir: string,
  /**
   * The configured connections, read live. A routine outlives the request that
   * made it, so a firing looks its own connection up here to learn where to
   * run — and a revoked token's routines find no connection and quietly do
   * nothing. Defaults to none, for the CLI verbs that build a host to add an
   * account and never serve.
   */
  connections: () => readonly ServerConnection[] = () => [],
): HeadlessHost {
  const providers = createDefaultProviderRegistry({
    claude: {
      /*
       * The memory tools, built per run by this process — the same seam the
       * desktop hands its browser and task tools across, and the only tools a
       * headless deployment has to give. `memoryTools` is declared below and
       * captured, not called, until a run starts.
       */
      agentToolServers: (_runId, input) => memoryTools(input),
      /*
       * The provider started a turn nobody asked for — register it.
       *
       * It does that when background work settles, and a subagent that outlived
       * its turn can park on a permission prompt the same way. Without this the
       * adapter has nowhere to report the turn and drops it — so a served client
       * watched its subagent spin for ever after it had finished, and never got
       * the agent's sentence about the result. `runs` is declared below and
       * captured, not called, until a process is live. Same wiring as the
       * desktop's `engine.ts` and the terminal's `host.ts`, and swallowed for
       * the same reason: this runs inside the adapter's own event pump.
       */
      onContinuation: (run, context) => {
        try {
          runs.adopt(run, context);
        } catch (error) {
          process.stderr.write(
            `Could not adopt the provider's own turn on run ${run.runId}: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
      },
    },
    /*
     * The same factory, for the provider whose loop is Artemis's own. One
     * call, not a second one built for the occasion — see the desktop's
     * `engine.ts`, which says the same thing about the same pair.
     */
    local: {
      agentToolServers: (_runId, input) => memoryTools(input),
    },
  });
  const managed = [...new Set(providers.list().flatMap((adapter) => managedEnvKeys(adapter.credentials)))];

  const profiles = new ProfileStore({
    userDataDir: dataDir,
    managedEnvKeys: managed,
    secrets: createFileProfileSecrets(dataDir),
  });

  const credentialsFor = (providerId: ProviderId) => {
    const adapter = providers.get(providerId);
    if (adapter === undefined) throw new Error(`No adapter for provider "${providerId}".`);
    return adapter.credentials;
  };

  const envFor = async (profileId: ProfileId, providerId: ProviderId) => {
    const profile = await profiles.require(profileId);
    const apiKey = await profiles.readApiKey(profileId);
    return resolveEnv(profile, {
      credentials: credentialsFor(providerId),
      ...(apiKey === null ? {} : { apiKey }),
    });
  };

  /**
   * This machine's own skills, slash commands and marketplace plugins,
   * delivered to the run — the desktop's `contentPluginsFor` and the
   * terminal's, through the same core seam. Resolved per run, so a skill
   * dropped into the container while it is up works on the next message. A
   * bridge that cannot be built is a line on stderr and a run without it,
   * never a run that does not start.
   *
   * Whose content this is deserves stating: the *server's*. A run reaches the
   * `skills/` of the account it runs as and the `~/.agents/skills` of the user
   * this process runs as — nothing from the client's disk, which is why
   * `GET /api/v0/commands` exists for the client to learn what is here.
   */
  const onContentWarning = (message: string, error: unknown): void => {
    process.stderr.write(`${message}: ${error instanceof Error ? error.message : String(error)}\n`);
  };
  const contentPluginsFor = async (profileId: ProfileId, providerId: ProviderId) => {
    if (providerId !== 'claude' && providerId !== 'codex') return [];
    const configDir = profiles.configDirFor(await profiles.require(profileId));
    if (providerId === 'codex') {
      await linkSkillsIntoCodexHome({ configDir, onWarning: onContentWarning });
      return [];
    }
    const [bridged, marketplace] = await Promise.all([
      buildContentBridge({ configDir, dataDir, onWarning: onContentWarning }),
      discoverMarketplacePlugins({ configDir, onWarning: onContentWarning }),
    ]);
    return [...bridged, ...marketplace];
  };

  const runs = new RunRegistry({
    resolveAdapter: (id) => providers.get(id),
    resolveRun: async ({ profileId, providerId }) => {
      const [env, plugins] = await Promise.all([
        envFor(profileId, providerId),
        contentPluginsFor(profileId, providerId),
      ]);
      return { env, plugins };
    },
    /*
     * Far above the registry's default of a thousand, because here the tail
     * is not a courtesy to a window that reloaded: it is what a client that
     * slept through a served turn is replayed on `GET /api/v0/runs/{id}/stream`.
     * A turn streams a text delta per token, so a thousand events is a few
     * minutes of output; a laptop lid is closed for longer than that. Each
     * event is a small object, and the runs a headless server holds at once
     * are few, so the memory is cheap next to the reply it saves.
     */
    historyLimit: 50_000,
  });

  const catalogue = createCatalogue({
    source: {
      listProfiles: () => profiles.listMetadata(),
      // The registry's own describe(), which probes availability the same way
      // the desktop's engine does — a serving machine without a provider's
      // CLI reports it unavailable rather than publishing routes that 500.
      listProviders: () => providers.describe({ includeUnregistered: false }),
      listModels: async ({ providerId, profileId }) => {
        const adapter = providers.get(providerId);
        if (adapter?.listModels === undefined) {
          return { models: providers.get(providerId)?.models ?? [], live: false };
        }
        return adapter.listModels({
          env: await envFor(profileId, providerId),
          cwd: dataDir,
        });
      },
      // The same probe the sign-in director polls, so the listing and the
      // login agree about what "signed in" means. A serving account that was
      // created and never signed in is the case this exists for: its routes
      // are published, they 401 on the first token, and nothing anywhere said
      // so.
      checkAuth: async ({ providerId, profileId }) => {
        const profile = (await profiles.list()).find((candidate) => candidate.id === profileId);
        if (profile === undefined) {
          return { loggedIn: false, error: 'This account is no longer configured.' };
        }
        return checkAuthStatus({
          credentials: credentialsFor(providerId),
          configDir: profiles.configDirFor(profile),
        });
      },
    },
  });

  const workspaces = createWorkspaceResolver();
  const ledger = createSessionLedger(dataDir);

  /**
   * Adding a serving account, and finding one to sign in.
   *
   * The one place `profile add` and `POST /api/v0/profiles` agree, which is
   * what stops the CLI and the API from producing subtly different accounts:
   * the same suggested directory, the same duplicate-label rule, the same
   * `mkdir`. A second implementation of any of those would be discovered by
   * whoever created an account one way and could not sign it in the other.
   */
  const profileAdmin: ProfileAdmin = {
    async create(draft) {
      const label = draft.label.trim();
      const existing = await profiles.list();
      /*
       * A label is not merely a name here: `assignProfileSlugs` derives a
       * route's left half from it, and two accounts called "work" become
       * `work` and `work-2` — an address that moves the day either is
       * renamed or deleted. The desktop tolerates duplicates because nothing
       * there is addressed by name; a server cannot.
       */
      if (existing.some((profile) => profile.label.trim().toLowerCase() === label.toLowerCase())) {
        throw new DuplicateProfileLabelError(label);
      }

      /*
       * A directory is *always* supplied, and that is a fix rather than a
       * convenience. `ProfileStore.create` requires one — a profile with no
       * directory has no account and no history — so `profile add --label work`
       * without `--config-dir` used to hand it `undefined` and die with
       * `"undefined" cannot be used as a config directory`, which is precisely
       * the invocation the deployment docs tell people to run.
       *
       * The store's own suggestion is `<dataDir>/profiles/<label>`, which is
       * the path the container documentation already names, and it is
       * *adopted* rather than reset when it already exists: a redeploy against
       * the same volume finds the credential the last one wrote and comes up
       * signed in.
       */
      const profile = await profiles.create({
        label,
        providerId: draft.providerId as ProviderId,
        configDir: draft.configDir ?? (await profiles.suggestConfigDir(label)),
      });

      const configDir = profiles.configDirFor(profile);
      // Made now rather than left to the CLI. The login is spawned with this
      // as its working directory, and a `spawn` into a directory that does not
      // exist fails with an `ENOENT` that names nothing a user could act on.
      await mkdir(configDir, { recursive: true });
      // The catalogue caches for minutes, and a client that has just added an
      // account will ask for it immediately.
      catalogue.invalidate();

      return describeProfile(profile.id, profile.providerId, profile.label, configDir);
    },

    async find(profileId) {
      const profile = await profiles.get(profileId as ProfileId);
      if (profile === undefined) return undefined;
      return describeProfile(
        profile.id,
        profile.providerId,
        profile.label,
        profiles.configDirFor(profile),
      );
    },

    async update(profileId, patch) {
      if (patch.label !== undefined) {
        const label = patch.label.trim();
        const existing = await profiles.list();
        // The create route's duplicate rule, applied to the rename that can
        // recreate the collision it exists to prevent: slugs are derived from
        // labels, and two accounts called "work" are two addresses that move.
        if (
          existing.some(
            (profile) =>
              profile.id !== (profileId as ProfileId) &&
              profile.label.trim().toLowerCase() === label.toLowerCase(),
          )
        ) {
          throw new DuplicateProfileLabelError(label);
        }
      }
      const updated = await profiles.update(profileId as ProfileId, {
        ...(patch.label === undefined ? {} : { label: patch.label.trim() }),
        ...(patch.baseUrl === undefined ? {} : { baseUrl: patch.baseUrl }),
        ...(patch.apiKey === undefined ? {} : { apiKey: patch.apiKey }),
      });
      // A rename moves the account's route slug; a new address changes what
      // its models are. Either way the published catalogue is stale.
      catalogue.invalidate();
      return describeProfile(
        updated.id,
        updated.providerId,
        updated.label,
        profiles.configDirFor(updated),
      );
    },

    async delete(profileId) {
      // The record, its key, its routes. The config directory stays - see the
      // interface's contract for why the wire never removes files.
      await profiles.delete(profileId as ProfileId, { deleteConfigDir: false });
      catalogue.invalidate();
    },
  };

  function describeProfile(
    id: ProfileId,
    providerId: ProviderId,
    label: string,
    configDir: string,
  ): ServerProfileRecord {
    return { id, label, providerId, configDir, credentials: credentialsFor(providerId) };
  }

  /*
   * The push feed: every agent event, stamped with the account its run bills
   * so the routes can filter per connection. Subscribed once, here, because
   * the feed's sequence numbers are the remote client's replay cursor and a
   * second subscription would number every event twice. `runs.get` covers
   * live and recently-ended runs, so even a run's own `run.end` still finds
   * its profile.
   */
  const feed = createPushFeed();
  runs.subscribe((event) => {
    const profileId = runs.get(event.runId)?.profileId;
    feed.publish(
      'artemis:push:agent-event',
      event,
      profileId === undefined ? {} : { profileId: String(profileId) },
    );
  });

  /**
   * A requested permission mode, kept only when the serving provider really
   * has it. Dropping rather than erroring is the wire's own convention — an
   * unsupported mode leaves the run in the serving user's setting, which is
   * exactly what every request got before modes could travel.
   */
  const clampMode = (providerId: ProviderId, mode: string | undefined): string | undefined => {
    if (mode === undefined) return undefined;
    const capabilities = providers.get(providerId)?.capabilities;
    return capabilities?.permissionModes.includes(mode as never) === true ? mode : undefined;
  };

  /**
   * The gauges, read where the accounts are and held once per account.
   *
   * A reading is a CLI control call per account, so one is allowed to be a
   * minute old — the same tolerance the desktop's own poller extends to an
   * idle profile. Failures are held too, briefly, so an account whose CLI is
   * wedged does not get probed on every request.
   *
   * Three things this is careful about, and it used to be careful about none
   * of them. All three produce the same symptom at the far end — two clients
   * on one account reading two different numbers — which is why they are one
   * cache rather than three fixes.
   *
   * **In-flight reads are shared.** The entry holds the *promise*, exactly as
   * `commandCache` below does. Two clients polling `/usage` a moment apart
   * otherwise each spawned a CLI for every account they asked about, and then
   * the one that answered last won regardless of which had the later truth.
   *
   * **Readings merge.** `mergePlanUsage` settles two accounts of one gauge per
   * window rather than per snapshot, so a slow read cannot undo a fast one and
   * a live `plan.limit` verdict cannot undo a poll that has since re-read the
   * window it was about.
   *
   * **A served run's verdicts land here.** The provider states a limit on every
   * API response, and those responses are this machine's runs — so the gauge a
   * remote client is shown is corrected within seconds of the provider deciding
   * something, rather than at the next cache expiry. See the subscription below.
   */
  const USAGE_CACHE_MS = 60_000;
  /** One account's reading, and the label the row carries it under. */
  type UsageRow = { readonly label: string; readonly usage: PlanUsage };
  /** Per account: when the read behind it started, and what it resolves to. */
  const usageCache = new Map<string, { readonly at: number; readonly value: Promise<UsageRow> }>();

  /**
   * Publish an account's reading, and drop it again if it turns out to fail.
   *
   * A rejection is not cached: an account whose CLI was away for one request
   * must not be answered "no" for the rest of the minute by the memory of it.
   * The identity check is what makes that safe when several of these overlap —
   * only the entry this call put there is removed.
   */
  const remember = (profileId: string, at: number, value: Promise<UsageRow>): Promise<UsageRow> => {
    usageCache.set(profileId, { at, value });
    value.catch(() => {
      if (usageCache.get(profileId)?.value === value) usageCache.delete(profileId);
    });
    return value;
  };

  /** Start one read, publish its promise, and merge what it learns on the way out. */
  const readUsage = (profileId: string): Promise<UsageRow> => {
    const held = usageCache.get(profileId);
    return remember(
      profileId,
      Date.now(),
      (async () => {
        const profile = await profiles.require(profileId as ProfileId);
        const adapter = providers.get(profile.providerId);
        if (adapter?.fetchPlanUsage === undefined) {
          throw new Error(`${String(profile.providerId)} does not report plan usage.`);
        }
        const usage = await adapter.fetchPlanUsage({
          profileId: profile.id,
          env: await envFor(profile.id, profile.providerId),
        } as never);
        /*
          Against whatever was held when this started rather than replacing it:
          a `plan.limit` folded in while this CLI was running is newer about its
          own window and older about every other, which is exactly the judgement
          `mergePlanUsage` makes window by window. A failed previous read is not
          evidence of anything and is merged against as an absence.
        */
        const previous = await held?.value.catch(() => undefined);
        return { label: profile.label, usage: mergePlanUsage(previous?.usage ?? null, usage) };
      })(),
    );
  };

  /**
   * How many times a read will follow the cache forward before answering.
   *
   * Each hop is a merge that landed while the caller was waiting — in practice
   * one, from a verdict folded in mid-read. The cap is there because the loop
   * reads a map that other requests are writing, and a bound is cheaper to
   * reason about than an argument that it cannot go round for ever.
   */
  const USAGE_CHAIN_HOPS = 8;

  const usageSource: UsageSource = {
    read: async (query) => {
      const rows: { profileId: string; label: string; usage: PlanUsage }[] = [];
      for (const profileId of query.profileIds) {
        const cached = usageCache.get(profileId);
        const fresh = cached !== undefined && Date.now() - cached.at < USAGE_CACHE_MS;
        try {
          let awaited = fresh && cached !== undefined ? cached.value : readUsage(profileId);
          let row = await awaited;
          /*
            The cache, not the read — the same rule the desktop's refresh handler
            answers by, and for the same reason.

            A verdict folded in while this read was out replaces the entry with a
            promise chained off the one being awaited here, so what the caller
            was waiting on is a reading the cache has already superseded. Without
            this the client whose request *caused* the read would be the one
            client shown the un-corrected gauge — a served account refusing
            requests, reported at its polled percentage, to exactly the client
            that asked. Every entry this follows is either chained off the
            promise just resolved or belongs to a later read, so neither can be
            waiting on this caller.
          */
          for (let hop = 0; hop < USAGE_CHAIN_HOPS; hop += 1) {
            const current = usageCache.get(profileId);
            if (current === undefined || current.value === awaited) break;
            awaited = current.value;
            row = await awaited;
          }
          rows.push({ profileId, label: row.label, usage: row.usage });
        } catch {
          // An unreadable gauge is a row that does not appear; the account
          // itself is untouched, and the next request past the cache retries.
        }
      }
      return rows;
    },
  };

  /**
   * Fold a served run's live limit verdict into that account's cached gauge.
   *
   * The provider states what it is doing with requests on every API response,
   * and on this machine those responses belong to runs this process is driving.
   * Without this the served gauge was polled-only: a remote client could be told
   * "97%" by a cache a few seconds old while this server was being refused
   * outright on that account — the same "97% but out" the desktop's own fold
   * exists to correct, one process further away.
   *
   * Only an account something has already been read for. A verdict names one
   * window and rarely carries a percentage, so a gauge built from one alone
   * would be a nearly-empty reading occupying the cache for a minute and
   * suppressing the real read behind it.
   *
   * The cache's stamp is deliberately *not* moved: a verdict is a correction to
   * a reading, not a reading, and pushing the expiry out on every API response
   * would mean the numbers were never re-read at all.
   */
  const foldPlanLimit = (event: AgentEvent): void => {
    if (event.type !== 'plan.limit') return;
    const profileId = runs.get(event.runId)?.profileId;
    if (profileId === undefined) return;
    const held = usageCache.get(String(profileId));
    if (held === undefined) return;
    remember(
      String(profileId),
      held.at,
      held.value.then((previous) => {
        const folded = applyPlanLimit(previous.usage, event.limit, Date.now());
        if (folded === null) return previous;
        return { label: previous.label, usage: mergePlanUsage(previous.usage, folded) };
      }),
    );
  };

  /*
   * Its own subscription rather than a second job for the feed's, which has to
   * stay exactly one publisher — see the note on `feed` above, where a second
   * subscription would number every event twice. This one publishes nothing.
   */
  runs.subscribe(foldPlanLimit);

  /**
   * The slash commands a session on one account would offer, for the route.
   *
   * Cached per account and directory for {@link COMMAND_CACHE_MS}, and
   * in-flight reads are shared, so two clients settling at once cost one CLI.
   * Asked with the same plugins a run here is given — the whole point: this
   * machine's skills arrive on that channel, and a list without them would be
   * missing exactly the rows the client is asking for.
   */
  const commandCache = new Map<string, { readonly at: number; readonly value: Promise<readonly string[]> }>();
  const commandSource: CommandSource = {
    list: (query) => {
      const providerId = query.providerId as ProviderId;
      const profileId = query.profileId as ProfileId;
      const adapter = providers.get(providerId);
      const listCommands = adapter?.listCommands?.bind(adapter);
      if (listCommands === undefined) return Promise.resolve([]);

      // The query has to start somewhere that exists — the same substitution
      // the desktop's engine makes for a column with no directory yet.
      const cwd = query.cwd ?? dataDir;
      const key = `${providerId} ${profileId} ${cwd}`;
      const cached = commandCache.get(key);
      if (cached !== undefined && Date.now() - cached.at < COMMAND_CACHE_MS) return cached.value;

      const value = (async (): Promise<readonly string[]> => {
        const [env, plugins] = await Promise.all([
          envFor(profileId, providerId),
          contentPluginsFor(profileId, providerId),
        ]);
        return listCommands({ env, cwd, plugins });
      })().catch((error: unknown) => {
        // The contract says the adapter resolves; if one rejects, that is a
        // bug in the adapter and not a reason to answer nothing for a minute
        // — the failure is dropped from the cache and the next ask retries.
        commandCache.delete(key);
        process.stderr.write(
          `Could not list slash commands for ${providerId}: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        return [];
      });
      commandCache.set(key, { at: Date.now(), value });
      return value;
    },
  };

  /**
   * The banks this machine carries, kept installed and fresh by this process.
   * See `memoryBanks.ts` for what is synchronous and what is not.
   */
  const banks = createServerMemoryBanks({ dataDir });

  /** Can this provider take an append on top of its own preset? */
  const canAppend = (providerId: string): boolean =>
    providers.get(providerId as ProviderId)?.capabilities.systemPromptAppend === true;

  /**
   * The memory tools for one run, or nothing.
   *
   * Nothing for a provider that cannot take them, and nothing for an account
   * that carries no bank — a server whose every call answers "no memory bank
   * reaches this run" teaches the model the feature is broken rather than that
   * it is not configured here.
   *
   * No credential is supplied. This process has no key manager and no window
   * to authorise one, so `landing.credential` is left unset and core falls
   * back to `git credential fill` — the container's ambient helper, or a
   * deploy key on an ssh remote, which is exactly how `memoryBanks.ts` already
   * pulls. See its header.
   */
  const memoryTools = (
    input: RunInput,
  ): Record<string, ReturnType<typeof memoryToolServer>> | undefined => {
    try {
      if (!takesHostTools(input.providerId) || !banks.reaches(input.profileId)) return undefined;
      return {
        [MEMORY_TOOL_SERVER]: memoryToolServer({
          dataDir,
          cliRegistryPath: registryPath(),
          profileId: input.profileId,
          cwd: input.cwd,
          log: (line) => process.stderr.write(`memory banks: ${line}\n`),
        }),
      };
    } catch (error) {
      // A run starts without the tools rather than not at all: memory is an
      // augmentation, and an augmentation that can fail a turn is a liability.
      process.stderr.write(
        `memory banks: could not build the memory tools: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return undefined;
    }
  };

  /**
   * This machine's memory-bank prompt for one run.
   *
   * Here and not on the client, because the prompt is about the machine the
   * run executes on — the banks *this* container carries, at the paths they
   * have here. The client's rendering would name its own slugs and a path on a
   * laptop; the desktop keeps that built-in off the wire for exactly this
   * reason. What the run contributes is which of them it may see (its
   * account's scope), which slice of each it is shown (its project), whether
   * the index is carried inline (its provider), and whether it can write
   * through the memory tools or has to be taught the bank's CLI (its provider
   * again — see {@link takesHostTools}, which decides both).
   *
   * Never throws: a bank that cannot be read is a run that starts without it.
   */
  const bankPrompt = (run: {
    readonly providerId: string;
    readonly profileId: string;
    readonly cwd: string;
  }): string | undefined => {
    try {
      return machineBankPrompt({
        dataDir,
        profileId: run.profileId,
        cwd: run.cwd,
        providerId: run.providerId,
        toolsAvailable: takesHostTools(run.providerId),
      });
    } catch (error) {
      process.stderr.write(
        `memory banks: could not compose the prompt: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return undefined;
    }
  };

  /**
   * A run about to start, with this machine's banks folded into it.
   *
   * The whole-`RunInput` paths — the remote bridge and this server's own
   * routines — go through here, which is the half that used to be missing:
   * both started runs on a machine whose banks were installed for them and
   * described to nobody. Three things happen, in this order, because the
   * install has to be on disk before the provider reads the project's memory
   * file at the start of the first turn:
   *
   *  1. the banks in scope are installed for this project, synchronously, and
   *     a pull is scheduled in the background;
   *  2. their prompt is appended, for a provider that can take an append —
   *     after the caller's own standing instructions, never replacing them;
   *  3. their checkouts are attached as readable directories, so a run whose
   *     tool sandbox is rooted at `cwd` can still open the files the index
   *     points at.
   *
   * A no-op returns the input by reference, so a server with no banks starts
   * exactly the run it would have started before any of this existed.
   */
  const withMemoryBanks = (input: RunInput): RunInput => {
    banks.prepare({ profileId: input.profileId, cwd: input.cwd });
    const withPrompt = canAppend(input.providerId)
      ? withSystemPromptAppended(input, bankPrompt(input))
      : input;
    const directories = mergeBankDirectories(
      input.additionalDirectories,
      banks.directoriesFor(input.profileId),
    );
    return directories === input.additionalDirectories
      ? withPrompt
      : { ...withPrompt, additionalDirectories: directories };
  };

  const runSource: RunSource = {
    startRun: (input) => {
      const permissionMode = clampMode(input.providerId as ProviderId, input.permissionMode);
      /*
       * The banks this account carries, installed for this project before the
       * run starts — see `withMemoryBanks`, which does the same for the two
       * paths that carry a whole `RunInput`. This one cannot: a completions
       * caller may not choose a tool set or a directory, so the bank
       * checkouts are not attached here and the prompt is the only thing the
       * run gets. A Claude harness loads the installed index itself.
       */
      banks.prepare({ profileId: input.profileId, cwd: input.cwd });

      /*
       * What the run is told, on top of the serving provider's preset: the
       * client's own standing instructions (the route has already set the
       * field aside for a provider that cannot append), then this machine's
       * memory-bank prompt, scoped to the account the turn bills.
       *
       * The wire and the adapter both refuse a replacement, so an append is
       * the only shape that reaches here.
       */
      const instructions = canAppend(input.providerId)
        ? joinSystemPromptAppends(input.systemPrompt, bankPrompt(input))
        : undefined;
      return runs.start({
        providerId: input.providerId as ProviderId,
        profileId: input.profileId as ProfileId,
        cwd: input.cwd,
        prompt: input.prompt,
        model: input.model,
        ...(input.effort === undefined ? {} : { effort: input.effort }),
        ...(input.fastMode === undefined ? {} : { fastMode: input.fastMode }),
        ...(input.ultracode === undefined ? {} : { ultracode: input.ultracode }),
        ...(input.resumeSessionId === undefined
          ? {}
          : { resumeSessionId: input.resumeSessionId as never }),
        // The caller's own conversation being reshaped — see the completions
        // route, which has already checked the account can honour them.
        ...(input.forkSession === undefined ? {} : { forkSession: input.forkSession }),
        ...(input.rewindToMessageId === undefined
          ? {}
          : { rewindToMessageId: input.rewindToMessageId as never }),
        ...(permissionMode === undefined ? {} : { permissionMode: permissionMode as never }),
        ...(instructions === undefined
          ? {}
          : { systemPrompt: { kind: 'append', text: instructions } as const }),
        // Already read and bounded by the route. The registry refuses them once
        // more against this account's own `imageInput` and `fileInput`, which
        // is the check that knows which provider is behind the route.
        ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
      } as never);
    },
    subscribe: (listener) => runs.subscribe(listener),
    interrupt: async (runId) => {
      await runs.interrupt(runId as RunId);
    },
    respondToPermission: async (runId, requestId, decision) => {
      await runs.respondToPermission(runId as RunId, requestId as never, decision as never);
    },
    disposeRun: async (runId) => {
      await runs.dispose(runId as RunId);
    },

    // The observation surface (ADR 0004).
    listRuns: async (query) => runs.list(query.cwd),
    /*
     * Conversations still working, the same three sets the desktop's engine
     * answers, from the same two sources: the registry for open turns, and
     * each adapter's own ledger for the work that outlives one — a
     * backgrounded subagent, a workflow, a registered schedule.
     *
     * This used to be absent, on the reasoning that the headless host keeps
     * no ledger of its own. It never needed one: the Claude adapter holds the
     * ledger, exactly as it does under the desktop, and the answer was one
     * call away. Without it a client — a remote window, or a desktop driving
     * a served account — was told nothing was working on this machine, so a
     * conversation with a subagent twenty minutes into its task read as
     * finished the moment its turn ended. `delegated` is what lets that
     * client redraw the rows after a reload or a sleep.
     */
    liveWork: async () => {
      const holding = new Set<string>();
      const working = new Set<string>();
      for (const handle of runs.list()) {
        if (handle.status !== 'ended' && handle.sessionId !== undefined) {
          holding.add(String(handle.sessionId));
          working.add(String(handle.sessionId));
        }
      }
      const delegated = new Map<string, SessionDelegatedWork>();
      for (const adapter of providers.list()) {
        for (const sessionId of adapter.sessionsHoldingWork?.() ?? []) holding.add(String(sessionId));
        // An adapter without the split falls back to its retention set — the
        // conservative reading, and the desktop engine's.
        for (const sessionId of adapter.sessionsWorking?.() ?? adapter.sessionsHoldingWork?.() ?? []) {
          working.add(String(sessionId));
        }
        for (const entry of adapter.delegatedWork?.() ?? []) {
          if (!delegated.has(String(entry.sessionId))) delegated.set(String(entry.sessionId), entry);
        }
      }
      return { sessionIds: [...holding], working: [...working], delegated: [...delegated.values()] };
    },
    getRun: async (runId) => runs.get(runId as RunId),
    runEvents: async (query) => {
      const after = query.afterSeq ?? -1;
      const events = runs.eventsSince(query.runId as RunId, after);
      // The buffer drops from the front, so a first event that is not the one
      // immediately after `after` is the only evidence that something was
      // lost — the same derivation the desktop's engine makes.
      const first = events[0];
      return { events, truncated: first !== undefined && first.seq > after + 1 };
    },

    // The control surface. `startUserRun` takes the whole RunInput — the
    // routes have already enforced the token's scope, and the registry
    // enforces capabilities exactly as it does for a window. The banks go in
    // here rather than in the routes, so every bridge-started run gets them
    // whatever route started it.
    startUserRun: (input) => runs.start(withMemoryBanks(input)),
    send: async (runId, text, attachments) => {
      const outcome = await runs.send(runId as RunId, text, attachments);
      return { deliveredImmediately: outcome.deliveredImmediately };
    },
    interruptRun: (runId) => runs.interrupt(runId as RunId),
    stopTask: (runId, taskId) => runs.stopTask(runId as RunId, taskId),
  };

  /*
   * The server's own routines: appointments that fire here, on schedule, with
   * no client attached. Started through `startUserRun` — a routine is the
   * connection owner's own scheduled work, so it runs with the whole
   * `RunInput` (metadata and mode and all), the same entry point the remote
   * bridge uses — and pinned to the connection's directory, resolved afresh on
   * every firing exactly as a completion's is. Its scheduler is begun by the
   * `serve` command after the port is bound and stopped by {@link dispose}.
   *
   * Through `withMemoryBanks` for the same reason the bridge is: a firing is
   * the most unattended run this process starts, and the one most in need of
   * the standing knowledge the banks hold.
   */
  const routines = createServerRoutineStore({
    dataDir,
    runs: {
      start: (input) => runs.start(withMemoryBanks(input)),
      subscribe: (listener) => runs.subscribe(listener),
    },
    workspaces,
    catalogue,
    connections,
  });

  /*
   * Interrupt-on-disconnect, and the attribution record in one wiring: a
   * bridge run whose client stays gone past the grace is interrupted, and the
   * session it announced is written into the ledger against the connection
   * that started it — `origin: 'bridge'`, so it is reachable from the whole
   * connection family later without ever being mistaken for a program's.
   */
  const guard = createRemoteRunGuard({
    interrupt: (runId) => runs.interrupt(runId as RunId),
    feed,
    onSession: (run, sessionId) => {
      ledger.record({
        sessionId,
        connectionId: run.connectionId,
        profileId: run.profileId,
        workspaceKey: run.workspaceKey,
        cwd: run.cwd,
        origin: 'bridge',
      });
    },
  });

  /*
   * The attribution log, on the same file the run lifecycle writes to.
   *
   * One story, one file: a bridge token started a run, the registry adopted
   * it, something ended it. Splitting the remote half into a log of its own
   * would mean correlating two files by timestamp to answer a question that is
   * one sentence long. Ids only — the log's `RECORDED_KEYS` allowlist is what
   * enforces that, rather than the caller remembering to.
   */
  const accessLog = new SessionLifecycleLog({
    file: join(dataDir, SESSION_LIFECYCLE_LOG_FILE),
    onError: (error) =>
      process.stderr.write(
        `could not append to the session-lifecycle log: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      ),
  });

  const sessionSource: SessionSource = {
    list: async (query) => {
      const adapter = providers.get(query.providerId as ProviderId);
      if (adapter?.listSessions === undefined) return { sessions: [], hasMore: false };
      return adapter.listSessions({
        profileId: query.profileId as ProfileId,
        cwd: query.cwd,
        env: await envFor(query.profileId as ProfileId, query.providerId as ProviderId),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
      });
    },
    messages: async (query) => {
      const profile = await profiles.require(query.profileId as ProfileId);
      const adapter = providers.get(profile.providerId);
      if (adapter?.getSessionMessages === undefined) return { events: [], hasMore: false };
      return adapter.getSessionMessages({
        profileId: query.profileId as ProfileId,
        sessionId: query.sessionId as never,
        runId: query.runId as never,
        env: await envFor(query.profileId as ProfileId, profile.providerId),
        ...(query.cwd === undefined ? {} : { cwd: query.cwd }),
        // The page the route was asked for, in the adapter's own unit — the
        // same stored messages `countSessionMessages` answers in.
        ...(query.limit === undefined ? {} : { limit: query.limit }),
        ...(query.offset === undefined ? {} : { offset: query.offset }),
      });
    },
    /*
     * The three writes, each present on the wire only insofar as the serving
     * adapter really has the method — the route answers 501 for the rest.
     * Normalisation lives here, not in the route: the reply shows the caller
     * what the store now says, and that answer has to be produced by whoever
     * does the storing (the same reasoning the desktop's rename handler
     * gives, with the same cap).
     */
    rename: async (query) => {
      const profile = await profiles.require(query.profileId as ProfileId);
      const adapter = providers.get(profile.providerId);
      if (adapter?.setSessionTitle === undefined) {
        throw new RunError('invalid_request', `${profile.providerId} cannot rename a stored session.`);
      }
      const title = query.title.trim().slice(0, MAX_SESSION_TITLE);
      if (title.length === 0) throw new RunError('invalid_request', 'A session title cannot be empty.');
      await adapter.setSessionTitle({
        sessionId: query.sessionId as never,
        title,
        env: await envFor(query.profileId as ProfileId, profile.providerId),
        ...(query.cwd === undefined ? {} : { cwd: query.cwd }),
      });
      return { title };
    },
    delete: async (query) => {
      const profile = await profiles.require(query.profileId as ProfileId);
      const adapter = providers.get(profile.providerId);
      if (adapter?.deleteSession === undefined) {
        throw new RunError('invalid_request', `${profile.providerId} cannot delete a stored session.`);
      }
      return adapter.deleteSession({
        sessionId: query.sessionId as never,
        env: await envFor(query.profileId as ProfileId, profile.providerId),
        ...(query.cwd === undefined ? {} : { cwd: query.cwd }),
      });
    },
    tag: async (query) => {
      const profile = await profiles.require(query.profileId as ProfileId);
      const adapter = providers.get(profile.providerId);
      if (adapter?.tagSession === undefined) {
        throw new RunError('invalid_request', `${profile.providerId} cannot tag a stored session.`);
      }
      return adapter.tagSession({
        sessionId: query.sessionId as never,
        env: await envFor(query.profileId as ProfileId, profile.providerId),
        tag: query.tag,
        ...(query.cwd === undefined ? {} : { cwd: query.cwd }),
      });
    },
  };

  return {
    profiles,
    providers,
    runs,
    catalogue,
    workspaces,
    ledger,
    runSource,
    sessionSource,
    usageSource,
    commandSource,
    routines,
    profileAdmin,
    memoryBankAdmin: {
      // Synchronous underneath — the registry is one small file — and promised
      // here because the seam is shaped for a host whose store is not.
      list: () => Promise.resolve(banks.list()),
      setScope: (slug: string, scope: ServerMemoryBankScope) =>
        Promise.resolve(banks.setScope(slug, scope)),
    },
    feed,
    guard,
    recordAccess: (event) => accessLog.record(event),
    dispose: async () => {
      guard.dispose();
      // Before the registry: a firing in flight would otherwise be torn out
      // from under its own history row on the way down.
      await routines.dispose();
      await runs.disposeAll();
      await ledger.flush();
      await workspaces.disposeAll();
    },
  };
}
