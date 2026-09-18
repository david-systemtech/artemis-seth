/**
 * What the server's composition root puts around a served run.
 *
 * Driven through `createHeadlessHost` itself — with the SDK replaced by a
 * scripted transport, so what is exercised is the chain a served client hangs
 * off: host → registry → Claude adapter → the registry's fan-out, which is
 * where the wire picks events up. Two things are asked of it here: that a
 * subagent outliving its turn is still seen to finish, and that this machine's
 * memory banks reach every path that starts a run.
 */

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, ProviderId, RoutineDraft, ServerConnection } from '@rx-artemis/protocol';
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

const sdkMock = vi.hoisted(() => ({
  onQuery: undefined as ((params: { prompt: unknown; options?: unknown }) => unknown) | undefined,
}));

// Resolved from core's own location and by real path, because pnpm's isolated
// linking means the bare specifier does not resolve from this package — and
// core's copy is the one that has to be replaced.
const sdk = await vi.hoisted(async () => {
  const { createRequire } = await import('node:module');
  const { realpathSync } = await import('node:fs');
  const fromCore = createRequire(realpathSync(createRequire(import.meta.url).resolve('@rx-artemis/core')));
  return { path: realpathSync(fromCore.resolve('@anthropic-ai/claude-agent-sdk')) };
});

vi.mock(sdk.path, () => ({
  query: (params: { prompt: unknown; options?: unknown }) => {
    if (sdkMock.onQuery === undefined) throw new Error('test did not install a query hook');
    return sdkMock.onQuery(params);
  },
  listSessions: () => Promise.resolve([]),
  /*
   * The memory tools are an in-process MCP server, built at run start through
   * the same `agentToolServers` seam the desktop hands its browser tools
   * across — so replacing the SDK means replacing its server builder too. What
   * the tools *do* is core's own tests' business; what matters here is that
   * the host built one and gave it to the run.
   */
  createSdkMcpServer: (config: { readonly name: string }) => ({
    type: 'sdk' as const,
    name: config.name,
    instance: {},
  }),
  tool: (name: string, description: string, inputSchema: unknown, handler: unknown) => ({
    name,
    description,
    inputSchema,
    handler,
  }),
}));

const { createHeadlessHost } = await import('./host.js');
const { AsyncQueue, REGISTRY_V2_FILE, projectKey, workspaceKeyFor } = await import('@rx-artemis/core');

/** How many plan-usage control calls the provider has been asked for. */
let usageCalls = 0;
/** What the next one answers. Replaced per test; gated where timing is the subject. */
let usageReply: () => Promise<unknown> = () => Promise.resolve({ rate_limits_available: false });

class FakeQuery {
  readonly messages = new AsyncQueue<SDKMessage>();
  closed = false;
  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return this.messages[Symbol.asyncIterator]();
  }
  interrupt(): Promise<{ still_queued: string[] }> {
    return Promise.resolve({ still_queued: [] });
  }
  async setModel(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  async applyFlagSettings(): Promise<void> {}
  /** The control call `fetchClaudeCommands` makes: a fixed list, since the plugins it was given are what is under test. */
  supportedCommands(): Promise<{ name: string; description: string; argumentHint: string }[]> {
    return Promise.resolve(
      ['compact', 'artemis-skills:unslop'].map((name) => ({ name, description: '', argumentHint: '' })),
    );
  }
  /**
   * The control call a plan-usage read makes.
   *
   * On the query object rather than on a second hook, because both a run and a
   * gauge reach the provider through the same `query()` — so one installed hook
   * has to answer both. What it answers, and how long it takes to, is
   * {@link usageReply}; the count is how the cache's in-flight sharing is
   * observed at all.
   */
  usage(): Promise<unknown> {
    usageCalls += 1;
    return usageReply();
  }
  close(): void {
    this.closed = true;
    this.messages.close();
  }
}

/**
 * @param onQuery observed at the instant the SDK is called, which is *during*
 *   the start — the only way to assert that something happened before a run
 *   rather than merely by the time the test looked.
 */
function installQuery(onQuery?: () => void) {
  let captured:
    | { fake: FakeQuery; prompt: AsyncIterable<SDKUserMessage>; options: Record<string, unknown> }
    | undefined;
  sdkMock.onQuery = (params) => {
    const fake = new FakeQuery();
    captured = {
      fake,
      prompt: params.prompt as AsyncIterable<SDKUserMessage>,
      options: (params.options ?? {}) as Record<string, unknown>,
    };
    onQuery?.();
    return fake;
  };
  const latest = () => {
    if (captured === undefined) throw new Error('query() was never called');
    return captured;
  };
  return {
    fake: () => latest().fake,
    prompts: () => latest().prompt[Symbol.asyncIterator](),
    options: () => latest().options,
    /** The text appended to the provider's preset, or `undefined` for none. */
    append: (): string | undefined => {
      const spec = latest().options['systemPrompt'];
      if (typeof spec !== 'object' || spec === null) return undefined;
      const append = (spec as { append?: unknown }).append;
      return typeof append === 'string' ? append : undefined;
    },
  };
}

const SESSION = 'sess-abc';
const sys = (subtype: string, rest: Record<string, unknown>): SDKMessage =>
  ({ type: 'system', subtype, session_id: SESSION, uuid: `${subtype}-${String(Math.random())}`, ...rest }) as unknown as SDKMessage;

const INIT = (cwd: string): SDKMessage =>
  sys('init', {
    cwd,
    model: 'claude-opus-4',
    tools: [],
    slash_commands: [],
    permissionMode: 'default',
    claude_code_version: '2.1.226',
    mcp_servers: [],
    apiKeySource: 'user',
    output_style: 'default',
    skills: [],
    plugins: [],
  });

const RESULT: SDKMessage = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 100,
  duration_api_ms: 90,
  num_turns: 1,
  result: 'done',
  stop_reason: 'end_turn',
  total_cost_usd: 0.01,
  usage: { input_tokens: 1, output_tokens: 2 },
  modelUsage: {},
  permission_denials: [],
  session_id: SESSION,
  uuid: 'result-1',
} as unknown as SDKMessage;

const tasksChanged = (ids: readonly string[]): SDKMessage =>
  sys('background_tasks_changed', {
    tasks: ids.map((task_id) => ({ task_id, task_type: 'local_agent', description: 'map the keybindings', status: 'running' })),
  });

const taskStarted = (task_id: string): SDKMessage =>
  sys('task_started', { task_id, task_type: 'local_agent', description: 'map the keybindings', subagent_type: 'Explore' });

const taskNotification = (task_id: string): SDKMessage =>
  sys('task_notification', { task_id, status: 'completed', summary: 'Found 14 bindings', usage: { total_tokens: 4200, tool_uses: 6, duration_ms: 9000 } });

const NOTIFICATION: SDKMessage = {
  type: 'user',
  parent_tool_use_id: null,
  uuid: 'notif-1',
  session_id: SESSION,
  origin: { kind: 'task-notification' },
  message: { role: 'user', content: '<task-notification>\n<task-id>t1</task-id>\n<status>completed</status>\n</task-notification>' },
} as unknown as SDKMessage;

const assistantText = (text: string, id = 'msg-a'): SDKMessage =>
  ({
    type: 'assistant',
    message: { id, role: 'assistant', content: [{ type: 'text', text }] },
    session_id: SESSION,
    uuid: `u-${id}`,
    parent_tool_use_id: null,
  }) as unknown as SDKMessage;

let root: string;
let cwd: string;
let dataDir: string;
/** The two served accounts' config directories, where their project memory lives. */
let configDirs: { work: string; personal: string };
let host: ReturnType<typeof createHeadlessHost>;

/** The bridge's connection, pinned to the run directory these tests use. */
const connection = (): ServerConnection => ({
  id: 'conn-a',
  label: 'Laptop',
  workspace: { kind: 'directory', path: cwd },
  token: 'token-a',
  createdAt: 0,
});

/** A legacy-flat bank with one memory in it. No git, so nothing ever pulls. */
async function writeBank(slug: string): Promise<string> {
  const bank = join(root, `bank-${slug}`);
  await mkdir(join(bank, 'memories'), { recursive: true });
  await writeFile(
    join(bank, 'memories', 'unraid-paths.md'),
    '---\nname: unraid-paths\ndescription: Before writing a host path on an Unraid box\nmetadata:\n  type: reference\n---\n\nUse /mnt/user.\n',
  );
  return bank;
}

/** Artemis's own registry, listing one bank at one profile scope. */
async function registerBank(
  slug: string,
  path: string,
  profiles: { kind: 'all' } | { kind: 'profiles'; profileIds: readonly string[] },
): Promise<void> {
  await writeFile(
    join(dataDir, REGISTRY_V2_FILE),
    JSON.stringify({
      version: 2,
      banks: [{ slug, path, role: 'readwrite', enabled: true, profiles }],
      default: slug,
    }),
  );
}

const profile = (id: string, label: string, configDir: string) => ({
  id,
  label,
  providerId: 'claude',
  configDir,
  publicEnv: {},
  createdAt: 1,
  updatedAt: 1,
});

beforeEach(async () => {
  usageCalls = 0;
  usageReply = () => Promise.resolve({ rate_limits_available: false });
  root = await mkdtemp(join(tmpdir(), 'artemis-served-settle-'));
  dataDir = join(root, 'data');
  cwd = join(root, 'work');
  configDirs = {
    work: join(dataDir, 'profiles', 'work'),
    personal: join(dataDir, 'profiles', 'personal'),
  };
  await Promise.all([
    mkdir(configDirs.work, { recursive: true }),
    mkdir(configDirs.personal, { recursive: true }),
    mkdir(cwd, { recursive: true }),
  ]);
  await writeFile(
    join(dataDir, 'profiles.json'),
    JSON.stringify({
      version: 2,
      profiles: [
        profile('prof_work', 'Work', configDirs.work),
        profile('prof_personal', 'Personal', configDirs.personal),
      ],
    }),
  );
  /*
   * The banks are read from this machine's own files, and by default that
   * means the *developer's* — `~/.config/cerebro/config.json` and the
   * single-bank era's `~/Documents/cerebro`. Both are pointed at this test's
   * scratch directory, so a machine that really carries banks neither leaks
   * them into these assertions nor has its CLI registry written to.
   */
  process.env['XDG_CONFIG_HOME'] = join(root, 'xdg');
  process.env['ARTEMIS_CEREBRO_ROOT'] = join(root, 'no-legacy-clone');
  host = createHeadlessHost(dataDir, () => [connection()]);
});

afterEach(async () => {
  sdkMock.onQuery = undefined;
  delete process.env['XDG_CONFIG_HOME'];
  delete process.env['ARTEMIS_CEREBRO_ROOT'];
  await host.dispose();
  await rm(root, { recursive: true, force: true });
});

describe('a subagent that outlives its served turn', () => {
  it('settles on the stream a client is listening to, on a turn of the provider\'s own', async () => {
    const seen: AgentEvent[] = [];
    host.runs.subscribe((event) => seen.push(event));
    const query = installQuery();

    const handle = await host.runs.start({ providerId: 'claude', profileId: 'prof_work' as never, cwd, prompt: 'delegate something', permissionMode: 'default' } as never);
    await query.prompts().next();
    const fake = query.fake();

    // The turn delegates and ends, leaving the subagent running.
    fake.messages.push(INIT(cwd));
    fake.messages.push(taskStarted('t1'));
    fake.messages.push(tasksChanged(['t1']));
    fake.messages.push(RESULT);
    await vi.waitFor(() => expect(seen.some((event) => event.type === 'run.end' && event.runId === handle.runId)).toBe(true));
    expect(fake.closed).toBe(false);

    // The subagent finishes; the CLI says so, then takes a turn of its own about it.
    fake.messages.push(tasksChanged([]));
    fake.messages.push(taskNotification('t1'));
    fake.messages.push(INIT(cwd));
    fake.messages.push(NOTIFICATION);
    fake.messages.push(assistantText('The Explore agent found 14 bindings.', 'msg-notif'));
    fake.messages.push(RESULT);

    await vi.waitFor(
      () => {
        const settled = seen.find(
          (event) => event.type === 'background.tasks' && event.tasks.some((task) => task.id === 't1' && task.status === 'completed'),
        );
        expect(settled).toBeDefined();
        // On a run the client never started — the one it has to be told about.
        expect(settled?.runId).not.toBe(handle.runId);
        expect(host.runs.get(settled!.runId)?.sessionId).toBe(SESSION);
      },
      { timeout: 3_000 },
    );
    expect(seen.some((event) => event.type === 'text.complete' && event.text === 'The Explore agent found 14 bindings.')).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* The banks this machine carries                                             */
/* -------------------------------------------------------------------------- */

type StartRunInput = Parameters<typeof host.runSource.startRun>[0];

const started = (overrides: Partial<StartRunInput> = {}): StartRunInput => ({
  providerId: 'claude',
  profileId: 'prof_work',
  cwd,
  prompt: 'what does the team know about this repo?',
  model: 'claude-opus-4',
  ...overrides,
});

describe('the memory banks this machine carries', () => {
  it('describes a bank to the account it is attached to, and to no other', async () => {
    await registerBank('cortex', await writeBank('cortex'), {
      kind: 'profiles',
      profileIds: ['prof_work'],
    });
    const query = installQuery();

    await host.runSource.startRun(started());
    expect(query.append()).toContain('`cortex`');

    // The same machine, the same bank, a different account: nothing about it
    // reaches the run, and nothing about it is installed for that account.
    await host.runSource.startRun(started({ profileId: 'prof_personal' }));
    expect(query.append()).toBeUndefined();
    expect(existsSync(join(configDirs.personal, 'projects', projectKey(cwd), 'memory', 'banks', 'cortex'))).toBe(false);
  });

  it('carries the bank on the bridge path and on a routine firing', async () => {
    const bank = await writeBank('cortex');
    await registerBank('cortex', bank, { kind: 'all' });
    const query = installQuery();

    // The bridge: a person at another machine, running with their own settings.
    await host.runSource.startUserRun!({
      providerId: 'claude',
      profileId: 'prof_work',
      cwd,
      prompt: 'catch me up',
    });
    expect(query.append()).toContain('`cortex`');
    // And the checkout itself, so a sandboxed tool can open what the index
    // points at — the bank lives outside the working directory.
    expect(query.options()['additionalDirectories']).toContain(bank);

    // A firing: the most unattended run this process starts.
    await host.routines.load();
    const draft: RoutineDraft = {
      name: 'Morning triage',
      instructions: 'Read the overnight alerts and summarise.',
      profileId: 'prof_work',
      providerId: 'claude',
      model: 'claude-opus-4',
      schedule: { kind: 'daily', at: '09:00' },
    };
    const created = await host.routines.create({ draft, connection: connection() });
    await host.routines.runNow(workspaceKeyFor(connection()), created.id);

    expect(query.options()['systemPrompt']).toBeDefined();
    expect(query.append()).toContain('`cortex`');
    expect(query.options()['additionalDirectories']).toContain(bank);
  });

  it('hands a provider whose harness will not load the memory file its index inline', async () => {
    await registerBank('cortex', await writeBank('cortex'), { kind: 'all' });
    /*
     * The same adapter under another id. What is under test is what the *host*
     * makes of the provider — a Claude harness loads the project's memory file
     * itself, and every other provider has to be told what is in it — not how
     * a local model runs, which has its own tests.
     */
    const claude = host.providers.get('claude');
    host.providers.register({ ...claude!, id: 'llamacpp' as ProviderId }, { replace: true });
    const query = installQuery();

    await host.runSource.startRun(started({ providerId: 'llamacpp' }));
    const append = query.append();
    expect(append).toContain('What `cortex` holds for this project');
    expect(append).toContain('Before writing a host path on an Unraid box');

    // The Claude account on the same machine is told where the index is, not
    // what is in it.
    await host.runSource.startRun(started());
    expect(query.append()).not.toContain('What `cortex` holds for this project');
  });

  it('installs the bank into the run\'s project before the run starts', async () => {
    await registerBank('cortex', await writeBank('cortex'), { kind: 'all' });
    const memory = join(configDirs.work, 'projects', projectKey(cwd), 'memory');

    // Read at the instant the SDK is called, which is inside the start: a
    // first run in a new project must not begin without the team's memory.
    let installedWhenQueried = false;
    installQuery(() => {
      installedWhenQueried = existsSync(join(memory, 'banks', 'cortex', 'unraid-paths.md'));
    });
    await host.runSource.startRun(started());

    expect(installedWhenQueried).toBe(true);
    const index = await readFile(join(memory, 'MEMORY.md'), 'utf8');
    expect(index).toContain('<!-- cerebro:cortex:begin -->');
    expect(index).toContain('unraid-paths.md');
  });

  it('gives a run on a provider that takes host tools the memory tools, and tells it so', async () => {
    await registerBank('cortex', await writeBank('cortex'), { kind: 'all' });
    const query = installQuery();

    await host.runSource.startRun(started());

    // The server itself, under the name the tools are addressed by:
    // `mcp__artemisMemory__memory_draft`.
    const servers = (query.options()['mcpServers'] ?? {}) as Record<string, unknown>;
    expect(Object.keys(servers)).toContain('artemisMemory');
    // And the prompt teaches the tools rather than the bank's CLI — a run told
    // to shell out when it has the tools spends a subprocess on nothing, and
    // one told the opposite calls a tool that is not there.
    const append = query.append();
    expect(append).toContain('memory_draft');
    expect(append).toContain('memory_promote');
    expect(append).not.toContain('cerebro draft');
  });

  it('gives a provider that cannot take host tools neither the server nor the words', async () => {
    await registerBank('cortex', await writeBank('cortex'), { kind: 'all' });
    /*
     * The same adapter under Codex's id, as the inline-index case does it:
     * what is under test is what the *host* makes of the provider — Codex runs
     * somebody else's harness and has nowhere to put an in-process MCP server
     * — not how Codex itself runs.
     */
    const claude = host.providers.get('claude');
    host.providers.register({ ...claude!, id: 'codex' as ProviderId }, { replace: true });
    const query = installQuery();

    await host.runSource.startRun(started({ providerId: 'codex' }));

    const servers = (query.options()['mcpServers'] ?? {}) as Record<string, unknown>;
    expect(Object.keys(servers)).not.toContain('artemisMemory');
    expect(query.append()).not.toContain('memory_draft');
    // It still hears about the bank; it is only the writing half that differs.
    expect(query.append()).toContain('`cortex`');
  });

  it('starts the run it always started on a machine with no banks', async () => {
    const query = installQuery();
    await host.runSource.startRun(started({ systemPrompt: 'Answer in one line.' }));
    // The client's own standing instructions, and nothing of this machine's.
    expect(query.append()).toBe('Answer in one line.');
    // The adapter attaches a scratch directory of its own for attachments; no
    // bank is among them, because there is no bank.
    const directories = (query.options()['additionalDirectories'] ?? []) as readonly string[];
    expect(directories.some((directory) => directory.startsWith(join(root, 'bank-')))).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* The skills this machine carries                                            */
/* -------------------------------------------------------------------------- */

describe('the skills this machine carries', () => {
  /*
   * The bridge also reads `~/.agents/skills`, and by default that is the
   * *developer's*. Pointed at this test's scratch directory so a machine that
   * really carries skills neither leaks them into these assertions nor has
   * its links reconciled by a test.
   */
  const home: { HOME?: string; USERPROFILE?: string } = {};
  beforeEach(async () => {
    home.HOME = process.env['HOME'];
    home.USERPROFILE = process.env['USERPROFILE'];
    const scratch = join(root, 'home');
    await mkdir(scratch, { recursive: true });
    process.env['HOME'] = scratch;
    process.env['USERPROFILE'] = scratch;
  });
  afterEach(() => {
    if (home.HOME === undefined) delete process.env['HOME'];
    else process.env['HOME'] = home.HOME;
    if (home.USERPROFILE === undefined) delete process.env['USERPROFILE'];
    else process.env['USERPROFILE'] = home.USERPROFILE;
  });

  /** A skill under one account's config directory, where the bridge looks. */
  async function installSkill(configDir: string, name: string): Promise<string> {
    const dir = join(configDir, 'skills', name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: A test skill\n---\n\nDo the thing.\n`);
    return dir;
  }

  const pluginsOf = (query: ReturnType<typeof installQuery>): readonly { readonly path: string }[] =>
    (query.options()['plugins'] ?? []) as readonly { readonly path: string }[];

  it('bridges an account’s skills into its served runs as a plugin, and into no other account’s', async () => {
    const skill = await installSkill(configDirs.work, 'unslop');
    const query = installQuery();

    await host.runSource.startRun(started());
    const plugins = pluginsOf(query);
    expect(plugins).toHaveLength(1);
    expect(plugins[0]?.path.startsWith(join(dataDir, 'content-bridges'))).toBe(true);
    // The bridge is a directory of this process's own, holding one link per
    // skill — the same arrangement the desktop builds. See core's `content/bridge.ts`.
    expect(await readlink(join(plugins[0]!.path, 'skills', 'unslop'))).toBe(skill);

    // The other account has no skills, so its run carries no plugin at all:
    // an empty list would still initialise the SDK's plugin machinery.
    await host.runSource.startRun(started({ profileId: 'prof_personal' }));
    expect(query.options()['plugins']).toBeUndefined();
  });

  it('lists the commands a run would offer, asked with the same plugins, and answers from memory for a while', async () => {
    const skill = await installSkill(configDirs.work, 'unslop');
    let opened = 0;
    const query = installQuery(() => {
      opened += 1;
    });

    const first = await host.commandSource.list({ profileId: 'prof_work', providerId: 'claude', cwd });
    expect(first).toEqual(['compact', 'artemis-skills:unslop']);
    // The CLI was asked in the run's directory, with the bridge a run gets.
    expect(query.options()['cwd']).toBe(cwd);
    expect(await readlink(join(pluginsOf(query)[0]!.path, 'skills', 'unslop'))).toBe(skill);

    const second = await host.commandSource.list({ profileId: 'prof_work', providerId: 'claude', cwd });
    expect(second).toEqual(first);
    expect(opened).toBe(1);
  });

  it('answers nothing for a provider that cannot enumerate commands', async () => {
    installQuery();
    expect(await host.commandSource.list({ profileId: 'prof_work', providerId: 'llamacpp', cwd })).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* The gauges this machine serves                                             */
/* -------------------------------------------------------------------------- */

/** A rate-limits payload, in the provider's own vocabulary. */
const limits = (fiveHour: number, sevenDay: number): unknown => ({
  subscription_type: 'max',
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: fiveHour },
    seven_day: { utilization: sevenDay },
  },
});

/** The provider's live verdict on one window, as a run's stream carries it. */
const rateLimited = (windowId: string, utilization: number): SDKMessage =>
  ({
    type: 'rate_limit_event',
    rate_limit_info: { status: 'rejected', rateLimitType: windowId, utilization },
    uuid: `rl-${windowId}`,
    session_id: SESSION,
  }) as unknown as SDKMessage;

/** The window of one served row, by id. */
const windowOf = (
  rows: readonly { readonly usage: { readonly windows: readonly { readonly id: string }[] } }[],
  id: string,
) => rows[0]?.usage.windows.find((w) => w.id === id) as
  | { utilization: number | null; status?: string }
  | undefined;

/**
 * What a remote client is told about an account's plan, and who decides it.
 *
 * A reading is a CLI control call per account, so it is cached for a minute —
 * and everything below is about that cache being one account's *reading* rather
 * than a race between whoever last wrote to it. Concurrent clients used to
 * spawn one CLI each and the later reply won regardless of which had seen the
 * later truth; a verdict the provider stated mid-run reached the desktop's own
 * cache and never this one, so a served gauge could read 97% on an account this
 * very process was being refused on.
 */
describe('the usage cache', () => {
  it('spawns one read when two clients ask for the same account at once', async () => {
    installQuery();
    let release: () => void = () => undefined;
    usageReply = () =>
      new Promise((resolve) => {
        release = () => resolve(limits(10, 20));
      });

    // Both asked before either answered — the shape a pair of clients polling a
    // second apart makes, and the one that used to cost two subprocesses and
    // resolve to whichever finished last.
    const both = Promise.all([
      host.usageSource.read({ profileIds: ['prof_work'] }),
      host.usageSource.read({ profileIds: ['prof_work'] }),
    ]);
    await vi.waitFor(() => expect(usageCalls).toBe(1));
    release();
    const [first, second] = await both;

    expect(usageCalls).toBe(1);
    expect(windowOf(first, 'five_hour')?.utilization).toBe(10);
    expect(second).toEqual(first);
  });

  it('does not let a slow read undo what was learned while it was out', async () => {
    /*
      A read takes a CLI spawn — a second or two — and the provider states a
      verdict on every API response, so a run on the same account routinely says
      something while a read of it is still in flight. Written by whoever
      finished last, the read lands on top and the refusal the server had
      already been told about is gone until the cache next expires: a served
      gauge reading 97% on an account this machine is being refused on.

      Here the verdict arrives *during* the read, and both have to survive it —
      the verdict on the window it named, the read's numbers on the rest.
    */
    const query = installQuery();
    let release: () => void = () => undefined;
    usageReply = () =>
      new Promise((resolve) => {
        release = () => resolve(limits(40, 55));
      });

    const reading = host.usageSource.read({ profileIds: ['prof_work'] });
    await vi.waitFor(() => expect(usageCalls).toBe(1));

    // A run on the same account, refused on its weekly window, while the read
    // above is still waiting on the CLI.
    await host.runs.start({
      providerId: 'claude',
      profileId: 'prof_work' as never,
      cwd,
      prompt: 'spend something',
      permissionMode: 'default',
    } as never);
    await query.prompts().next();
    const fake = query.fake();
    fake.messages.push(INIT(cwd));
    fake.messages.push(rateLimited('seven_day', 97));

    release();
    await reading;

    await vi.waitFor(async () => {
      const rows = await host.usageSource.read({ profileIds: ['prof_work'] });
      expect(windowOf(rows, 'seven_day')?.status).toBe('rejected');
    });
    const rows = await host.usageSource.read({ profileIds: ['prof_work'] });
    expect(windowOf(rows, 'five_hour')?.utilization).toBe(40);
    // One CLI for the whole exchange: the correction cost nothing.
    expect(usageCalls).toBe(1);
  });

  it('corrects a cached gauge from a served run\'s own limit verdict', async () => {
    /*
      The provider states what it is doing with requests on every API response,
      and on this machine those responses belong to runs this process drives. A
      client polling `/usage` would otherwise be shown a minute-old percentage
      while this server was being refused outright — the same "97% but out" the
      desktop's fold exists to correct, one process further away.
    */
    const query = installQuery();
    usageReply = () => Promise.resolve(limits(40, 97));

    const before = await host.usageSource.read({ profileIds: ['prof_work'] });
    expect(windowOf(before, 'seven_day')?.status).toBeUndefined();

    const handle = await host.runs.start({
      providerId: 'claude',
      profileId: 'prof_work' as never,
      cwd,
      prompt: 'spend something',
      permissionMode: 'default',
    } as never);
    await query.prompts().next();
    const fake = query.fake();
    fake.messages.push(INIT(cwd));
    fake.messages.push(rateLimited('seven_day', 97));

    await vi.waitFor(async () => {
      const rows = await host.usageSource.read({ profileIds: ['prof_work'] });
      expect(windowOf(rows, 'seven_day')?.status).toBe('rejected');
    });

    // From the cache, not from a second CLI: the correction is free.
    expect(usageCalls).toBe(1);
    // And the window the verdict said nothing about keeps its polled number.
    const after = await host.usageSource.read({ profileIds: ['prof_work'] });
    expect(windowOf(after, 'five_hour')?.utilization).toBe(40);
    expect(handle.runId).toBeDefined();
  });

  it('retries an account whose read failed rather than remembering the failure', async () => {
    // A rejection cached for a minute is an account answered "no" by the memory
    // of a CLI that was away for one request.
    installQuery();
    usageReply = () => Promise.reject(new Error('control channel closed'));
    const failed = await host.usageSource.read({ profileIds: ['prof_work'] });
    // The adapter degrades rather than throwing, so the row exists and says so.
    expect(failed[0]?.usage.available).toBe(false);

    usageReply = () => Promise.resolve(limits(5, 6));
    const retried = await host.usageSource.read({ profileIds: ['prof_work'] });
    // Still cached — `available: false` is an answer, and a minute old is the
    // tolerance every other reading gets.
    expect(retried[0]?.usage.available).toBe(false);
    expect(usageCalls).toBe(1);
  });
});
