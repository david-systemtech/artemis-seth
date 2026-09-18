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
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
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

  it('offers a skill once when an enabled marketplace plugin publishes the same name', async () => {
    // The desktop's rule, reached through the same core call: the plugin is
    // handed over whole, so the bridge is the side that yields.
    const installPath = join(root, 'plugin-cache', 'pstack');
    const key = 'pstack@claude-plugins-official';
    await mkdir(join(installPath, '.claude-plugin'), { recursive: true });
    await writeFile(join(installPath, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'pstack' }));
    await mkdir(join(installPath, 'skills', 'unslop'), { recursive: true });
    await writeFile(join(installPath, 'skills', 'unslop', 'SKILL.md'), '---\nname: unslop\n---\n\nTheirs.\n');
    await mkdir(join(configDirs.work, 'plugins'), { recursive: true });
    await writeFile(
      join(configDirs.work, 'plugins', 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins: { [key]: [{ scope: 'user', installPath }] } }),
    );
    await writeFile(join(configDirs.work, 'settings.json'), JSON.stringify({ enabledPlugins: { [key]: true } }));
    await installSkill(configDirs.work, 'unslop');
    await installSkill(configDirs.work, 'house-rules');
    const query = installQuery();

    await host.runSource.startRun(started());

    const plugins = pluginsOf(query);
    expect(plugins.map((plugin) => plugin.path)).toContain(installPath);
    const bridge = plugins.find((plugin) => plugin.path.startsWith(join(dataDir, 'content-bridges')));
    expect(await readdir(join(bridge!.path, 'skills'))).toEqual(['house-rules']);
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

  it('reads a caller’s always-on skills off its own disk, after the caller’s instructions', async () => {
    await installSkill(configDirs.work, 'unslop');
    const query = installQuery();

    await host.runSource.startRun(
      started({ systemPrompt: 'Follow the house style.', alwaysOnSkills: ['unslop', 'not-carried-here'] }),
    );

    const append = query.append();
    // The server's copy of the body, under the heading a local run gives it…
    expect(append).toContain('# Always-on skill: unslop');
    expect(append).toContain('Do the thing.');
    // …after what the person wrote, and with nothing for a name it does not carry.
    expect(append.indexOf('Follow the house style.')).toBeLessThan(append.indexOf('# Always-on skill: unslop'));
    expect(append).not.toContain('not-carried-here');
  });

  it('lists what it carries, and keeps a repository it is given cloned, bridged and removable', async () => {
    await installSkill(configDirs.work, 'house-rules');
    // A real repository, reached the way a server reaches one: by URL.
    const upstream = join(root, 'upstream');
    await mkdir(join(upstream, 'skills', 'unslop'), { recursive: true });
    await writeFile(
      join(upstream, 'skills', 'unslop', 'SKILL.md'),
      '---\nname: unslop\ndescription: De-slop prose.\n---\n\nEdit.\n',
    );
    for (const args of [
      ['init', '-q', '-b', 'main'],
      ['add', '-A'],
      ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'skills'],
    ]) {
      execFileSync('git', args, { cwd: upstream });
    }
    // Named by an https URL, as a real one is — the only kind the registry
    // keeps — and pointed at the scratch repository by git's own rewrite rule,
    // so nothing here touches the network.
    const url = 'https://skills.test/agent-skills';
    const gitConfig = {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `url.${pathToFileURL(upstream).href}.insteadOf`,
      GIT_CONFIG_VALUE_0: url,
    };
    Object.assign(process.env, gitConfig);
    onTestFinished(() => {
      for (const key of Object.keys(gitConfig)) delete process.env[key];
    });

    expect(await host.skillsAdmin.addSource({ url, subdir: 'skills' })).toBeNull();

    const listed = await host.skillsAdmin.list({ profileIds: ['prof_work', 'prof_personal'] });
    expect(listed.skills.map((skill) => [skill.name, skill.origin.kind])).toEqual([
      ['house-rules', 'profile'],
      ['unslop', 'source'],
    ]);
    expect(listed.sources).toMatchObject([{ source: { url, subdir: 'skills' }, cloned: true, skillCount: 1 }]);

    // A served run on either account is offered the synced skill.
    const query = installQuery();
    await host.runSource.startRun(started({ profileId: 'prof_personal' }));
    expect(await readdir(join(pluginsOf(query)[0]!.path, 'skills'))).toEqual(['unslop']);

    const id = listed.sources[0]!.source.id;
    expect(await host.skillsAdmin.syncSources(id)).toBe(true);
    expect(await host.skillsAdmin.syncSources('no-such-source')).toBe(false);
    expect(await host.skillsAdmin.removeSource(id)).toBe(true);
    expect(await host.skillsAdmin.removeSource(id)).toBe(false);
    expect((await host.skillsAdmin.list({ profileIds: [] })).skills).toEqual([]);
  }, 60_000);

  it('refuses a twenty-first repository in a sentence, and stores nothing for it', async () => {
    // Written straight into the registry: twenty clones would prove nothing
    // about the limit and take a minute doing it.
    await writeFile(
      join(dataDir, 'skills.json'),
      JSON.stringify({
        version: 1,
        alwaysOn: [],
        sources: Array.from({ length: 20 }, (_, index) => ({
          url: `https://skills.test/repo-${String(index)}`,
          subdir: 'skills',
        })),
      }),
    );

    const refused = await host.skillsAdmin.addSource({ url: 'https://skills.test/one-more', subdir: 'skills' });

    expect(refused).toMatch(/at most 20 skill repositories/);
    const kept = (await host.skillsAdmin.list({ profileIds: [] })).sources.map((status) => status.source.url);
    expect(kept).toHaveLength(20);
    expect(kept).not.toContain('https://skills.test/one-more');
  });

  it('answers nothing for a provider that cannot enumerate commands', async () => {
    installQuery();
    expect(await host.commandSource.list({ profileId: 'prof_work', providerId: 'llamacpp', cwd })).toEqual([]);
  });
});
