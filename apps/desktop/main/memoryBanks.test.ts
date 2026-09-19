/**
 * The pure half of `memoryBanks.ts`: the decisions, without the disk or the
 * spawns around them.
 *
 * What is here changed shape when core learned to read banks itself. There is
 * no CLI output to parse any more — a bank's condition is built from what
 * `readBankAt` found in the directory, which is why the fixtures below are
 * *directories*, written into a temp dir and read the way the app reads them.
 * The CLI's registry parser stays, because the CLI's file is still mirrored on
 * every write and a machine may still have one written by hand.
 *
 * The same convention covers the spawn's pure halves, added when the module
 * learned to run on Windows and to reach a private remote: which interpreter
 * to drive the legacy CLI with, what every spawn is told, and what one
 * `git ls-remote` means. Those are decisions rather than I/O, and the fixtures
 * for the last one are stderr the hosts in reach actually produce — the whole
 * value of the feature is that four indistinguishable-looking failures are
 * told apart.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  detectForge,
  EphemeralMemoryBankSecrets,
  readBankAt,
  REGISTRY_V2_FILE,
  type BankRecord,
  type Forge,
  type SecretRef,
} from '@rx-artemis/core';
import type { MemoryBankCheck } from '@rx-artemis/protocol';

import {
  acceptsAsPython3,
  bankInfoFrom,
  baseCliEnv,
  categorizeLsRemote,
  configureMemoryBanks,
  forgeCredentialFor,
  hasBankBlock,
  hasSessionStartSyncHook,
  isFollowUpsAsIssues,
  isMasterEnabled,
  setFollowUpsAsIssues,
  setMasterEnabled,
  needsPythonInterpreter,
  parseGitOrigin,
  parseRegistry,
  pullDue,
  PYTHON_CANDIDATES,
  readMemoryBanksPreflight,
  readMemoryBanksStatus,
  selectPython,
  syncDue,
  wireMemoryBankClaudeCode,
  withoutSecrets,
  type LsRemoteResult,
  type PythonProbe,
} from './memoryBanks';

/* -------------------------------------------------------------------------- */
/* A bank's condition, from the bank                                          */
/* -------------------------------------------------------------------------- */

const RECORD: BankRecord = {
  slug: 'cerebro',
  path: '',
  role: 'readwrite',
  enabled: true,
  profiles: { kind: 'all' },
};

/**
 * A legacy-flat bank on disk: one memory that validates and one file that
 * cannot be read as one. Both halves matter — the pane counts the second and
 * shows the reason, which is how the person who can fix it finds out.
 */
function writeLegacyFlatBank(): string {
  const root = mkdtempSync(join(tmpdir(), 'artemis-bank-'));
  mkdirSync(join(root, 'memories'), { recursive: true });
  writeFileSync(
    join(root, 'memories', 'deploy-approval-flow.md'),
    [
      '---',
      'name: deploy-approval-flow',
      'description: When deploying to production',
      'metadata:',
      '  type: reference',
      '  added: 2026-08-14',
      '  author: demo@example.com',
      '---',
      '',
      'Deploys need approval in #deploys first.',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(join(root, 'memories', 'broken.md'), 'no frontmatter at all\n', 'utf8');
  return root;
}

describe('bankInfoFrom', () => {
  const facts = {
    isDefault: true,
    remote: null,
    source: 'artemis@1a2b3c4',
    projects: 2,
    embedsCli: false,
  };

  it('describes a legacy bank read off disk, problems and all', () => {
    const path = writeLegacyFlatBank();
    const record = { ...RECORD, path };
    const info = bankInfoFrom(record, readBankAt(path, { slug: record.slug }), facts);

    expect(info).toMatchObject({
      slug: 'cerebro',
      // A legacy bank says nothing about itself, so the slug is its name.
      name: 'cerebro',
      description: null,
      format: 'legacy-flat',
      exists: true,
      memories: 2,
      validationErrors: 1,
      // The field the old CLI filled from its mirror trees; core has no such
      // notion, and the protocol's number is honestly zero.
      mirrored: 0,
      projects: 2,
      isDefault: true,
      profiles: { kind: 'all' },
    });
    // One file, several reasons — each its own line, each naming the file, so
    // the pane can show them without knowing which bank format produced them.
    expect(info.problems.length).toBeGreaterThan(0);
    expect(info.problems.every((problem) => problem.startsWith('memories/broken.md: '))).toBe(true);
    expect(info.problems.join(' ')).toMatch(/no frontmatter/);
  });

  it('reads a manifest bank`s own name and description', () => {
    const path = writeLegacyFlatBank();
    writeFileSync(
      join(path, 'BANK.md'),
      ['---', 'name: cortex', 'description: The homelab and its machines.', '---', '', 'Body.', ''].join('\n'),
      'utf8',
    );
    const record = { ...RECORD, path, slug: 'cortex' };
    const info = bankInfoFrom(record, readBankAt(path, { slug: record.slug }), facts);
    expect(info.format).toBe('manifest');
    expect(info.name).toBe('cortex');
    expect(info.description).toBe('The homelab and its machines.');
  });

  it('describes a path that is no longer a bank without losing the record', () => {
    // The registry still names it, so the pane can offer to forget it. What it
    // must not do is claim the bank is there.
    const record = { ...RECORD, path: join(tmpdir(), 'artemis-not-a-bank') };
    const info = bankInfoFrom(record, null, { ...facts, source: null, projects: 0 });
    expect(info).toMatchObject({
      exists: false,
      format: null,
      memories: 0,
      validationErrors: 0,
      problems: [],
      path: record.path,
      slug: 'cerebro',
      name: 'cerebro',
    });
  });

  it('caps the problems it reports, because the count is already exact', () => {
    const path = mkdtempSync(join(tmpdir(), 'artemis-bank-'));
    mkdirSync(join(path, 'memories'), { recursive: true });
    for (let i = 0; i < 20; i += 1) {
      writeFileSync(join(path, 'memories', `broken-${String(i)}.md`), 'nothing\n', 'utf8');
    }
    const info = bankInfoFrom({ ...RECORD, path }, readBankAt(path, { slug: 'cerebro' }), facts);
    expect(info.validationErrors).toBe(20);
    expect(info.problems).toHaveLength(12);
  });
});

/* -------------------------------------------------------------------------- */
/* What a profile carries, for stock Claude Code's sake                       */
/* -------------------------------------------------------------------------- */

describe('hasSessionStartSyncHook', () => {
  const settings = (command: string): string =>
    JSON.stringify({
      hooks: {
        SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command }] }],
      },
    });

  it('recognises the hook however the CLI happened to be spelled', () => {
    // A shim on PATH, a bank's own copy, and the Windows spawn — all one hook.
    expect(hasSessionStartSyncHook(settings('cerebro sync --quiet'))).toBe(true);
    expect(hasSessionStartSyncHook(settings('/home/me/Documents/cortex/bin/cerebro sync --quiet'))).toBe(true);
    expect(hasSessionStartSyncHook(settings('py -3 C:\\banks\\cortex\\bin\\cerebro sync'))).toBe(true);
  });

  it('is false for another SessionStart hook, and for a cerebro that does not sync', () => {
    expect(hasSessionStartSyncHook(settings('echo hello'))).toBe(false);
    expect(hasSessionStartSyncHook(settings('cerebro doctor'))).toBe(false);
  });

  it('is false for a settings file with no hooks, and for one that will not parse', () => {
    expect(hasSessionStartSyncHook('{}')).toBe(false);
    expect(hasSessionStartSyncHook(JSON.stringify({ hooks: { PreToolUse: [] } }))).toBe(false);
    expect(hasSessionStartSyncHook('')).toBe(false);
    expect(hasSessionStartSyncHook('{ "hooks": ')).toBe(false);
  });
});

describe('hasBankBlock', () => {
  it('finds the legacy slug`s unprefixed marker and a named bank`s', () => {
    expect(hasBankBlock('# Notes\n\n<!-- cerebro:begin -->\n- one\n<!-- cerebro:end -->\n', 'cerebro')).toBe(true);
    expect(hasBankBlock('<!-- cerebro:brandsolidate:begin -->\n', 'brandsolidate')).toBe(true);
  });

  it('does not mistake one bank`s block for another`s', () => {
    expect(hasBankBlock('<!-- cerebro:brandsolidate:begin -->\n', 'cortex')).toBe(false);
    expect(hasBankBlock('# Nothing here\n', 'cerebro')).toBe(false);
  });
});

describe('parseRegistry', () => {
  it('reads the multi-bank shape, defaulting role and enabled', () => {
    const { banks, defaultSlug } = parseRegistry(
      JSON.stringify({
        banks: [
          { slug: 'cerebro', path: '/a' },
          { slug: 'docs', path: '/b', role: 'readonly', enabled: false },
        ],
        default: 'cerebro',
      }),
    );
    expect(banks).toEqual([
      { slug: 'cerebro', path: '/a', role: 'readwrite', enabled: true },
      { slug: 'docs', path: '/b', role: 'readonly', enabled: false },
    ]);
    expect(defaultSlug).toBe('cerebro');
  });

  it('reads the pre-multi-bank shape as one legacy bank', () => {
    const { banks, defaultSlug } = parseRegistry(JSON.stringify({ bank: '/Users/demo/Documents/cerebro' }));
    expect(banks).toEqual([
      { slug: 'cerebro', path: '/Users/demo/Documents/cerebro', role: 'readwrite', enabled: true },
    ]);
    expect(defaultSlug).toBe('cerebro');
  });

  it('falls back to the first bank when the default names nobody', () => {
    const { defaultSlug } = parseRegistry(
      JSON.stringify({ banks: [{ slug: 'a', path: '/a' }], default: 'gone' }),
    );
    expect(defaultSlug).toBe('a');
  });

  it('drops malformed entries and survives garbage whole', () => {
    expect(parseRegistry('not json')).toEqual({ banks: [], defaultSlug: null });
    const { banks } = parseRegistry(
      JSON.stringify({ banks: [{ slug: 'ok', path: '/a' }, { slug: 'NO CAPS', path: '/b' }, { path: '/c' }, 42] }),
    );
    expect(banks.map((bank) => bank.slug)).toEqual(['ok']);
  });
});

describe('the master switch', () => {
  it('reads as off until configured, and off when the file is absent', () => {
    configureMemoryBanks(mkdtempSync(join(tmpdir(), 'artemis-banks-')));
    expect(isMasterEnabled()).toBe(false);
  });

  it('reads the historical cerebro.json, so an upgrade keeps the yes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'artemis-banks-'));
    writeFileSync(join(dir, 'cerebro.json'), JSON.stringify({ version: 1, enabled: true }));
    configureMemoryBanks(dir);
    expect(isMasterEnabled()).toBe(true);
  });

  it('treats anything but `enabled: true` as off', () => {
    const dir = mkdtempSync(join(tmpdir(), 'artemis-banks-'));
    writeFileSync(join(dir, 'cerebro.json'), JSON.stringify({ version: 1, enabled: 'yes' }));
    configureMemoryBanks(dir);
    expect(isMasterEnabled()).toBe(false);
  });
});

/*
 * The briefing switch shares the gate's file and inverts its default, which is
 * the pair of facts most likely to be broken by a later edit: a writer that
 * forgets the other key, or a reader that copies the gate's "absent means no".
 */
describe('the follow-ups-as-issues switch', () => {
  const machine = (): string => mkdtempSync(join(tmpdir(), 'artemis-banks-'));

  it('reads as on before configuration and when the file is absent', () => {
    configureMemoryBanks(machine());
    expect(isFollowUpsAsIssues()).toBe(true);
  });

  it('stays on for a machine upgrading from a file that predates it', () => {
    // The gate's own file, written before this setting existed. Silence there
    // is not a no — it is a machine that was never asked.
    const dir = machine();
    writeFileSync(join(dir, 'cerebro.json'), JSON.stringify({ version: 1, enabled: true }));
    configureMemoryBanks(dir);
    expect(isFollowUpsAsIssues()).toBe(true);
  });

  it('is off only when it says so exactly', () => {
    const dir = machine();
    writeFileSync(
      join(dir, 'cerebro.json'),
      JSON.stringify({ version: 1, enabled: true, followUpsAsIssues: false }),
    );
    configureMemoryBanks(dir);
    expect(isFollowUpsAsIssues()).toBe(false);
  });

  it('keeps the gate when it is written, and the gate keeps it', () => {
    // One file, two writers. Either one dropping the other's key would show up
    // as a setting silently reverting to its default.
    const dir = machine();
    configureMemoryBanks(dir);

    setFollowUpsAsIssues({ enabled: false });
    expect(isMasterEnabled()).toBe(false);
    expect(isFollowUpsAsIssues()).toBe(false);

    setMasterEnabled({ enabled: true });
    expect(isMasterEnabled()).toBe(true);
    expect(isFollowUpsAsIssues()).toBe(false);

    setFollowUpsAsIssues({ enabled: true });
    expect(isMasterEnabled()).toBe(true);
    expect(isFollowUpsAsIssues()).toBe(true);

    // And the file on disk agrees, for the next process to read.
    const onDisk = JSON.parse(readFileSync(join(dir, 'cerebro.json'), 'utf8')) as Record<string, unknown>;
    expect(onDisk['enabled']).toBe(true);
    expect(onDisk['followUpsAsIssues']).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Getting the CLI to run at all                                              */
/* -------------------------------------------------------------------------- */

/**
 * The Windows spawn, as the pure decision behind it.
 *
 * Before this, every bank operation threw on Windows before the CLI's first
 * line ran: the file is an extension-less Python script with a shebang, which
 * `execFile` cannot start on a platform that has no shebang support and
 * matches executables by `PATHEXT`. What is testable without a machine is the
 * decision — does this path need an interpreter, and is this thing calling
 * itself Python actually one.
 */
describe('needsPythonInterpreter', () => {
  it('is true for a bank`s embedded script on Windows and false everywhere else', () => {
    expect(needsPythonInterpreter('C:/banks/team/bin/cerebro', 'win32')).toBe(true);
    expect(needsPythonInterpreter('/Users/me/Documents/cortex/bin/cerebro', 'darwin')).toBe(false);
    expect(needsPythonInterpreter('/home/me/cortex/bin/cerebro', 'linux')).toBe(false);
  });

  it('leaves a real executable alone, so a bank may embed one', () => {
    // The only CLI that is ever resolved is a bank's *own* copy, and a bank is
    // free to ship something Windows can start by itself.
    expect(needsPythonInterpreter('C:/banks/team/bin/cerebro.exe', 'win32')).toBe(false);
    expect(needsPythonInterpreter('C:/banks/team/bin/cerebro.cmd', 'win32')).toBe(false);
    expect(needsPythonInterpreter('C:/banks/team/bin/cerebro.BAT', 'win32')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Which CLI, if any — and what depends on the answer                         */
/* -------------------------------------------------------------------------- */

/**
 * A bank on disk, optionally carrying its own `bin/cerebro`.
 *
 * The CLI is written as a plain file rather than a runnable one: nothing here
 * spawns it. What is under test is *resolution* — which is a question about
 * whether the file is there, and about the fallbacks that no longer exist.
 */
function writeBank(embedsCli: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'artemis-cli-bank-'));
  mkdirSync(join(root, 'memories'), { recursive: true });
  if (embedsCli) {
    mkdirSync(join(root, 'bin'), { recursive: true });
    writeFileSync(join(root, 'bin', 'cerebro'), '#!/usr/bin/env python3\n', 'utf8');
  }
  return root;
}

/**
 * A data directory whose registry lists these banks — and a scratch
 * `XDG_CONFIG_HOME`, so the CLI's real registry on the developing machine is
 * neither read into the answer nor written to.
 */
function machineWithBanks(banks: readonly { slug: string; path: string }[]): string {
  const dataDir = mkdtempSync(join(tmpdir(), 'artemis-cli-data-'));
  process.env['XDG_CONFIG_HOME'] = join(dataDir, 'xdg');
  writeFileSync(
    join(dataDir, REGISTRY_V2_FILE),
    JSON.stringify({
      version: 2,
      banks: banks.map((bank) => ({
        ...bank,
        role: 'readwrite',
        enabled: true,
        profiles: { kind: 'all' },
      })),
      default: banks[0]?.slug ?? null,
    }),
  );
  return dataDir;
}

/**
 * Resolution, after the vendored copy left the build.
 *
 * The rule is now one sentence — a bank is driven by its own `bin/cerebro` or
 * by nothing — and the tests that matter are the ones about what was *removed*:
 * there is no copy shipped beside the app, no borrowing the default bank's,
 * and no legacy root to fall back through. A machine whose banks carry none has
 * no CLI at all, and that is an ordinary state rather than a fault.
 */
describe('the CLI a bank is driven with', () => {
  afterEach(() => {
    delete process.env['XDG_CONFIG_HOME'];
    delete process.env['ARTEMIS_VENDORED_CEREBRO'];
  });

  it('reports the bank that embeds one, per bank', async () => {
    const withCli = writeBank(true);
    const without = writeBank(false);
    configureMemoryBanks(
      machineWithBanks([
        { slug: 'cortex', path: withCli },
        { slug: 'notes', path: without },
      ]),
    );

    const status = await readMemoryBanksStatus();
    expect(status.banks.map((bank) => [bank.slug, bank.embedsCli])).toEqual([
      ['cortex', true],
      ['notes', false],
    ]);
    // The machine-wide answer is "any of them", and it is about one thing only:
    // whether stock Claude Code can be wired to anything here.
    expect(status.cliAvailable).toBe(true);
  });

  it('does not borrow another bank`s copy for a bank that has none', async () => {
    // The removed fallback. `cortex` is the default bank and carries a CLI;
    // `notes` still answers `false`, because its block is namespaced by its own
    // slug and another repository's script is not a substitute.
    configureMemoryBanks(
      machineWithBanks([
        { slug: 'cortex', path: writeBank(true) },
        { slug: 'notes', path: writeBank(false) },
      ]),
    );
    const status = await readMemoryBanksStatus();
    expect(status.banks.find((bank) => bank.slug === 'notes')?.embedsCli).toBe(false);
  });

  it('has no vendored copy to fall back to, however it is pointed at one', async () => {
    // Artemis used to ship a CLI and let `ARTEMIS_VENDORED_CEREBRO` move it.
    // Neither exists: a machine whose banks embed none has no CLI, full stop.
    process.env['ARTEMIS_VENDORED_CEREBRO'] = join(tmpdir(), 'anything');
    configureMemoryBanks(machineWithBanks([{ slug: 'notes', path: writeBank(false) }]));

    const status = await readMemoryBanksStatus();
    expect(status.cliAvailable).toBe(false);
    expect(status.banks[0]?.embedsCli).toBe(false);
  });
});

/**
 * The preflight's `cli` row, which stopped being about Artemis.
 *
 * It used to mean "can this machine drive a bank at all", and a `warn` there
 * read as a degraded install. Everything Artemis does with a bank is core's
 * now, so the row answers a narrower question — can anything here be wired
 * into stock Claude Code — and says so in the words a person needs to not go
 * looking for a fault.
 */
describe('readMemoryBanksPreflight: the cli check', () => {
  afterEach(() => {
    delete process.env['XDG_CONFIG_HOME'];
  });

  const cliCheck = async (): Promise<MemoryBankCheck> => {
    const check = (await readMemoryBanksPreflight()).checks.find((entry) => entry.id === 'cli');
    if (check === undefined) throw new Error('the preflight no longer reports a cli check');
    return check;
  };

  it('is ok when a registered bank embeds one', async () => {
    configureMemoryBanks(machineWithBanks([{ slug: 'cortex', path: writeBank(true) }]));
    expect((await cliCheck()).state).toBe('ok');
  });

  it('warns — and says everything else works — when none does', async () => {
    configureMemoryBanks(machineWithBanks([{ slug: 'notes', path: writeBank(false) }]));
    const check = await cliCheck();
    expect(check.state).toBe('warn');
    expect(check.detail).toBe(
      'no bank embeds the cerebro CLI; stock Claude Code wiring is unavailable, everything else works',
    );
  });

  it('never fails on it, so a machine with no CLI is still ready', async () => {
    // The whole point of the demotion: the row is about the other harness, and
    // `ready` is about whether this one can carry a bank.
    configureMemoryBanks(machineWithBanks([{ slug: 'notes', path: writeBank(false) }]));
    const preflight = await readMemoryBanksPreflight();
    expect(preflight.checks.find((check) => check.id === 'cli')?.state).not.toBe('fail');
  });
});

/**
 * Wiring, refused.
 *
 * The success path spawns a Python script inside a git checkout and is not
 * something a unit test should arrange. What is worth pinning is the refusal,
 * because it is the one the removal of the vendored copy created: a bank with
 * no `bin/cerebro` cannot be wired by anything, and the sentence has to name
 * the bank and say that Artemis is unaffected — otherwise it reads as Artemis
 * being broken.
 */
describe('wireMemoryBankClaudeCode', () => {
  afterEach(() => {
    delete process.env['XDG_CONFIG_HOME'];
  });

  it('refuses a bank that embeds no CLI, by name', async () => {
    configureMemoryBanks(machineWithBanks([{ slug: 'notes', path: writeBank(false) }]));
    await expect(wireMemoryBankClaudeCode({ slug: 'notes', enabled: true })).rejects.toThrow(
      /'notes' embeds no cerebro CLI/,
    );
    await expect(wireMemoryBankClaudeCode({ slug: 'notes', enabled: false })).rejects.toThrow(
      /Artemis’s own runs are unaffected/,
    );
  });

  it('refuses a slug this machine does not have', async () => {
    configureMemoryBanks(machineWithBanks([{ slug: 'notes', path: writeBank(false) }]));
    await expect(wireMemoryBankClaudeCode({ slug: 'gone', enabled: true })).rejects.toThrow(
      /No memory bank called 'gone'/,
    );
  });
});

describe('acceptsAsPython3', () => {
  const probe = (over: Partial<PythonProbe>): PythonProbe => ({
    ok: true,
    stdout: '',
    stderr: '',
    ...over,
  });

  it('accepts a real Python 3, from either stream', () => {
    expect(acceptsAsPython3(probe({ stdout: 'Python 3.13.1\n' }))).toBe(true);
    // `--version` went to stderr on 3.3 and earlier.
    expect(acceptsAsPython3(probe({ stderr: 'Python 3.8.10\n' }))).toBe(true);
  });

  it('rejects the Windows Store stub, which exits fine and says nothing', () => {
    // The rejection that matters. `WindowsApps\python3.exe` is an
    // app-execution alias whose whole job is to open the Store; accepting it
    // means every later spawn either opens a shop or fails in a way that names
    // no Python at all.
    expect(acceptsAsPython3(probe({ ok: true, stdout: '', stderr: '' }))).toBe(false);
    expect(acceptsAsPython3(probe({ ok: true, stdout: '   \n' }))).toBe(false);
  });

  it('rejects a failed probe and a Python 2', () => {
    expect(acceptsAsPython3(probe({ ok: false, stderr: 'python3 is not recognized' }))).toBe(false);
    expect(acceptsAsPython3(probe({ stdout: 'Python 2.7.18' }))).toBe(false);
    expect(acceptsAsPython3(probe({ stdout: 'Perl 5.38.0' }))).toBe(false);
  });
});

describe('selectPython', () => {
  const said = (text: string): PythonProbe => ({ ok: true, stdout: text, stderr: '' });
  const failed: PythonProbe = { ok: false, stdout: '', stderr: 'not found' };

  it('tries the launcher first, so a machine with Python 2 still gets 3', () => {
    expect(PYTHON_CANDIDATES.map((candidate) => [candidate.command, ...candidate.args].join(' '))).toEqual([
      'py -3',
      'python3',
      'python',
    ]);
  });

  it('takes the first candidate that answers as Python 3', () => {
    const chosen = selectPython([
      { candidate: { command: 'py', args: ['-3'] }, probe: failed },
      { candidate: { command: 'python3', args: [] }, probe: said('Python 3.12.4') },
    ]);
    expect(chosen).toEqual({ command: 'python3', args: [] });
  });

  it('skips a stub that exited zero in favour of the next candidate', () => {
    const chosen = selectPython([
      { candidate: { command: 'python3', args: [] }, probe: said('') },
      { candidate: { command: 'python', args: [] }, probe: said('Python 3.11.9') },
    ]);
    expect(chosen).toEqual({ command: 'python', args: [] });
  });

  it('is null when nothing on the machine is a Python 3', () => {
    expect(
      selectPython([
        { candidate: { command: 'py', args: ['-3'] }, probe: failed },
        { candidate: { command: 'python3', args: [] }, probe: said('') },
        { candidate: { command: 'python', args: [] }, probe: said('Python 2.7.18') },
      ]),
    ).toBeNull();
  });
});

/**
 * The environment every spawn is told, which is the fix for the *other* thing
 * that was broken off macOS: without `ARTEMIS_ROOT` the CLI looks for
 * `profiles.json` under `~/Library/Application Support/Artemis`, finds none on
 * any other platform, and `doctor` reports the machine unready forever.
 */
describe('baseCliEnv', () => {
  it('names the Artemis root and forbids a terminal prompt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'artemis-banks-'));
    configureMemoryBanks(dir);
    expect(baseCliEnv()).toEqual({ ARTEMIS_ROOT: dir, GIT_TERMINAL_PROMPT: '0' });
  });
});

/* -------------------------------------------------------------------------- */
/* Verifying a remote                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The categorisation, against stderr the hosts in reach actually produce.
 *
 * These strings are the point of the feature. "Could not clone" is true of a
 * private repository, a typo, a laptop on a plane and a repository that does
 * not exist, and the four remedies are entirely different — so what is
 * asserted here is that each one lands in the category whose remedy is the
 * right one.
 */
describe('categorizeLsRemote', () => {
  const ran = (over: Partial<LsRemoteResult>): LsRemoteResult => ({
    code: 128,
    timedOut: false,
    stdout: '',
    stderr: '',
    ...over,
  });

  it('reads a HEAD line as a reachable repository', () => {
    const result = categorizeLsRemote(
      ran({ code: 0, stdout: '52a0a3271f9c4b0e8d3a6f2c1b7e9d40a5c8e136\tHEAD\n' }),
    );
    expect(result.outcome).toBe('ok');
    expect(result.headPresent).toBe(true);
    expect(result.detail).toContain('52a0a327');
  });

  it('reads exit 2 with nothing fatal as a readable, empty repository', () => {
    // `--exit-code` exits 2 when no ref matched, which for HEAD means an empty
    // repo — a perfectly good bank to join, and what a team's second machine
    // sees on the day the bank is created.
    const result = categorizeLsRemote(ran({ code: 2 }));
    expect(result.outcome).toBe('ok');
    expect(result.headPresent).toBe(false);
  });

  it('reads a prompt that could not be answered as needing credentials', () => {
    // The everyday private-repo case, with GIT_TERMINAL_PROMPT=0 in force.
    expect(
      categorizeLsRemote(
        ran({
          stderr:
            "fatal: could not read Username for 'https://git.example.com': terminal prompts disabled\n",
        }),
      ).outcome,
    ).toBe('auth-required');
  });

  it('reads a rejected token as needing credentials, not as an outage', () => {
    // Both hosts answer through "unable to access", which also matches a
    // connectivity shape — the auth patterns are asked first for this reason.
    expect(
      categorizeLsRemote(
        ran({
          stderr:
            "fatal: unable to access 'https://git.example.com/team/bank.git/': The requested URL returned error: 403\n",
        }),
      ).outcome,
    ).toBe('auth-required');
    expect(
      categorizeLsRemote(ran({ stderr: "fatal: Authentication failed for 'https://git.example.com/'\n" }))
        .outcome,
    ).toBe('auth-required');
  });

  it('reads a missing repository as missing', () => {
    expect(
      categorizeLsRemote(ran({ stderr: 'remote: Repository not found.\nfatal: repository not found\n' }))
        .outcome,
    ).toBe('not-found');
  });

  it('reads a name that will not resolve, or a host that will not answer, as unreachable', () => {
    expect(
      categorizeLsRemote(
        ran({
          stderr: "fatal: unable to access 'https://nope.invalid/': Could not resolve host: nope.invalid\n",
        }),
      ).outcome,
    ).toBe('unreachable');
    expect(
      categorizeLsRemote(ran({ stderr: 'fatal: unable to access: Failed to connect to 10.0.0.9 port 443\n' }))
        .outcome,
    ).toBe('unreachable');
  });

  it('reports a timeout as unreachable, in its own words', () => {
    const result = categorizeLsRemote(ran({ code: null, timedOut: true }));
    expect(result.outcome).toBe('unreachable');
    expect(result.detail).toMatch(/did not answer/);
  });

  it('carries the last line git wrote, which is the useful one', () => {
    const result = categorizeLsRemote(
      ran({ stderr: 'Cloning into bare repository...\nremote: Repository not found.\n' }),
    );
    expect(result.detail).toBe('remote: Repository not found.');
  });
});

/**
 * The scrub that stands between a token and the pane.
 *
 * Nothing observed says git echoes a password it was handed. This is what
 * makes that a claim the boundary does not have to rely on.
 */
describe('withoutSecrets', () => {
  it('removes the exact token, wherever it appears', () => {
    const token = 'forgejo-9f3c1a77b2e04d6a8c5f0e1b7d4a9268';
    const said = `fatal: authentication failed with ${token} for https://git.example.com`;
    const scrubbed = withoutSecrets(said, [token]);
    expect(scrubbed).not.toContain(token);
    expect(scrubbed).toContain('[redacted]');
  });

  it('still applies the shape rules to everything else', () => {
    expect(withoutSecrets('remote said sk-ant-abcdefghijklmnop', [])).toContain('[redacted]');
  });

  it('leaves an ordinary message alone', () => {
    expect(withoutSecrets('remote: Repository not found.', [])).toBe('remote: Repository not found.');
  });
});

/**
 * Finding a bank's origin without spawning anything, because this is read on
 * the background sync's path — which fires at the start of every run.
 */
describe('parseGitOrigin', () => {
  it('reads origin’s url out of a real .git/config', () => {
    expect(
      parseGitOrigin(
        [
          '[core]',
          '\trepositoryformatversion = 0',
          '[remote "upstream"]',
          '\turl = https://git.example.com/other/thing.git',
          '[remote "origin"]',
          '\turl = https://git.example.com/team/bank.git',
          '\tfetch = +refs/heads/*:refs/remotes/origin/*',
        ].join('\n'),
      ),
    ).toBe('https://git.example.com/team/bank.git');
  });

  it('is null for a repository with no origin, and for anything unreadable', () => {
    expect(parseGitOrigin('[core]\n\tbare = false\n')).toBeNull();
    expect(parseGitOrigin('')).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* What a landing authenticates with                                          */
/* -------------------------------------------------------------------------- */

/**
 * The credential core asks this process for when it lands a memory.
 *
 * Core opens the pull request and merges it over the forge's API, and holds no
 * credential of its own: it names a *forge* and this module answers with what
 * Artemis holds for that host, or with `null` so core can fall back to
 * `git credential fill`. Three answers matter and they are the three below —
 * the bank on that host, a bank somewhere else, and a bank whose token lives
 * in a key manager that will not give it up.
 */
describe('forgeCredentialFor', () => {
  /** A bank checkout with nothing in it but an origin. */
  function bankWithOrigin(remote: string): string {
    const root = mkdtempSync(join(tmpdir(), 'artemis-forge-bank-'));
    mkdirSync(join(root, 'memories'), { recursive: true });
    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, '.git', 'config'), `[remote "origin"]\n\turl = ${remote}\n`, 'utf8');
    return root;
  }

  /**
   * A data directory whose registry lists one bank — and a scratch
   * `XDG_CONFIG_HOME`, so the CLI's real registry on the developing machine is
   * neither read into the answer nor written to.
   */
  function machineWith(slug: string, bankPath: string): string {
    const dataDir = mkdtempSync(join(tmpdir(), 'artemis-forge-data-'));
    process.env['XDG_CONFIG_HOME'] = join(dataDir, 'xdg');
    writeFileSync(
      join(dataDir, REGISTRY_V2_FILE),
      JSON.stringify({
        version: 2,
        banks: [{ slug, path: bankPath, role: 'readwrite', enabled: true, profiles: { kind: 'all' } }],
        default: slug,
      }),
    );
    return dataDir;
  }

  const forgeFor = (remote: string): Forge => {
    const forge = detectForge(remote);
    if (forge === null) throw new Error(`not a forge: ${remote}`);
    return forge;
  };

  const REF: SecretRef = {
    provider: 'openbao',
    connectionId: 'conn-1',
    mount: 'kv',
    path: 'banks/cortex',
    key: 'git_token',
  };

  afterEach(() => {
    delete process.env['XDG_CONFIG_HOME'];
  });

  it('answers with the token held for a bank whose origin is on that host', async () => {
    const bank = bankWithOrigin('https://forge.example/team/cortex.git');
    const secrets = new EphemeralMemoryBankSecrets();
    await secrets.write('cortex', { kind: 'token', token: 'forge-token', username: 'david' });
    configureMemoryBanks(machineWith('cortex', bank), secrets);

    expect(await forgeCredentialFor(forgeFor('https://forge.example/team/cortex.git'))).toEqual({
      username: 'david',
      token: 'forge-token',
    });
    // The *host* is what is matched, not the repository: a second bank on the
    // same Forgejo lands with the first one's token rather than needing its own.
    expect(await forgeCredentialFor(forgeFor('https://forge.example/other/notes.git'))).toEqual({
      username: 'david',
      token: 'forge-token',
    });
  });

  it('answers null for a forge no bank on this machine is on', async () => {
    const bank = bankWithOrigin('https://forge.example/team/cortex.git');
    const secrets = new EphemeralMemoryBankSecrets();
    await secrets.write('cortex', { kind: 'token', token: 'forge-token', username: 'david' });
    configureMemoryBanks(machineWith('cortex', bank), secrets);

    // `null` rather than the token: core falls back to `git credential fill`,
    // and a token for one host must never be presented to another.
    expect(await forgeCredentialFor(forgeFor('https://github.com/team/cortex.git'))).toBeNull();
  });

  it('answers null when the bank’s reference cannot be resolved, and records why', async () => {
    const bank = bankWithOrigin('https://forge.example/team/cortex.git');
    const secrets = new EphemeralMemoryBankSecrets();
    await secrets.write('cortex', { kind: 'ref', ref: REF, username: 'david' });
    const dataDir = machineWith('cortex', bank);
    configureMemoryBanks(dataDir, secrets, () => Promise.reject(new Error('vault is sealed')));

    expect(await forgeCredentialFor(forgeFor('https://forge.example/team/cortex.git'))).toBeNull();

    // And the sentence survives, for the pane — the three ways a key manager
    // refuses look identical from the outside otherwise.
    const status = await readMemoryBanksStatus();
    expect(status.banks[0]?.credential).toMatchObject({ kind: 'ref', problem: 'vault is sealed' });
  });
});

describe('syncDue: the per-directory throttle', () => {
  const MINUTE = 60_000;

  it('lets the first sync through, and the same directory again after a minute', () => {
    expect(syncDue({ lastSyncAt: 0 }, '/w/app', 1)).toBe(true);
    expect(syncDue({ lastSyncAt: 1000, lastSyncCwd: '/w/app' }, '/w/app', 1000 + MINUTE)).toBe(true);
  });

  it('skips a burst of runs in the directory it just synced', () => {
    expect(syncDue({ lastSyncAt: 1000, lastSyncCwd: '/w/app' }, '/w/app', 1000 + MINUTE / 2)).toBe(false);
    // A caller that names no directory is the old behaviour: throttled by time alone.
    expect(syncDue({ lastSyncAt: 1000, lastSyncCwd: '/w/app' }, undefined, 1000 + MINUTE / 2)).toBe(false);
  });

  it('goes through for a directory the last sync did not know about', () => {
    /*
     * The case the time-only throttle swallowed: a second project opened
     * within a minute of the first started without its bank installed, and
     * stayed that way until a bank commit happened to trigger the
     * every-project install.
     */
    expect(syncDue({ lastSyncAt: 1000, lastSyncCwd: '/w/app' }, '/w/other', 1000 + 5)).toBe(true);
    expect(syncDue({ lastSyncAt: 1000 }, '/w/app', 1000 + 5)).toBe(true);
  });
});

describe('pullDue: the per-bank network throttle', () => {
  const MINUTE = 60_000;

  it('lets a bank that has never pulled through', () => {
    expect(pullDue(undefined, 0)).toBe(true);
  });

  it('holds a bank that pulled within the last quarter of an hour', () => {
    expect(pullDue(1000, 1000 + 5 * MINUTE)).toBe(false);
    expect(pullDue(1000, 1000 + 14 * MINUTE)).toBe(false);
  });

  it('lets it through again at fifteen minutes', () => {
    // The install half still runs on every pass; this throttle is only about
    // asking the forge, which a bank people commit to a few times a day does
    // not benefit from being asked more often than this.
    expect(pullDue(1000, 1000 + 15 * MINUTE)).toBe(true);
  });
});
