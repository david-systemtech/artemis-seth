/**
 * Keeping a bank installed across profiles, and what a pull is asked of.
 * Real directories, as in the other bank tests.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readBankAt } from '../formats.js';
import type { BankRegistryV2 } from '../registryV2.js';
import { hasRemote, installBankEverywhere, pullBank, reconcileBankInstalls, sharedIndexBudget, uninstallBankEverywhere } from '../sync.js';

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'artemis-bank-sync-'));
}

function bankWith(names: readonly string[]): string {
  const dir = scratch();
  mkdirSync(join(dir, 'memories'));
  for (const name of names) {
    writeFileSync(join(dir, 'memories', `${name}.md`), `---\nname: ${name}\ndescription: About ${name}\nmetadata:\n  type: reference\n---\n\nFact.\n`);
  }
  return dir;
}

/** A data directory with two profiles, each with one existing project. */
function dataDirWithProfiles(): { dataDir: string; home: string; work: string } {
  const dataDir = scratch();
  const home = join(dataDir, 'profiles', 'home');
  const work = join(dataDir, 'profiles', 'work');
  mkdirSync(join(home, 'projects', 'C--x-repo'), { recursive: true });
  mkdirSync(join(work, 'projects', 'C--x-repo'), { recursive: true });
  writeFileSync(
    join(dataDir, 'profiles.json'),
    JSON.stringify({ profiles: [{ id: 'p-home', label: 'Home', configDir: home }, { id: 'p-work', label: 'Work', configDir: work }] }),
  );
  return { dataDir, home, work };
}

describe('hasRemote and pullBank', () => {
  it('sees no remote in a repository that has none, and does not pull it', { timeout: 30_000 }, async () => {
    const repo = scratch();
    mkdirSync(join(repo, '.git'));
    writeFileSync(join(repo, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n');
    expect(hasRemote(repo)).toBe(false);
    expect(await pullBank(repo)).toEqual({ pulled: false, detail: 'no remote to pull from' });
    expect(hasRemote(scratch())).toBe(false);
  });

  it('sees a remote when one is configured', () => {
    const repo = scratch();
    mkdirSync(join(repo, '.git'));
    writeFileSync(join(repo, '.git', 'config'), '[core]\n\tbare = false\n[remote "origin"]\n\turl = https://example.test/x.git\n');
    expect(hasRemote(repo)).toBe(true);
  });
});

describe('sharedIndexBudget', () => {
  it('divides the allowance between banks and never starves one', () => {
    expect(sharedIndexBudget(1)).toEqual({ lines: 170, bytes: 22_000 });
    expect(sharedIndexBudget(2)).toEqual({ lines: 85, bytes: 11_000 });
    expect(sharedIndexBudget(0)).toEqual(sharedIndexBudget(1));
    expect(sharedIndexBudget(100)).toEqual({ lines: 10, bytes: 2000 });
  });
});

describe('installing across profiles', () => {
  it('installs into the profiles the scope covers, plus the run\'s own project', { timeout: 30_000 }, () => {
    const bank = readBankAt(bankWith(['one']), { slug: 'team' });
    const { dataDir, home, work } = dataDirWithProfiles();
    const record = { slug: 'team', path: bank!.root, role: 'readwrite' as const, enabled: true, profiles: { kind: 'profiles' as const, profileIds: ['p-work'] } };
    const cwd = join(scratch(), 'fresh-project');
    const report = installBankEverywhere(bank!, { record, dataDir, cwd, today: '2026-09-15' });
    expect(report.profiles).toBe(1);
    expect(report.projects).toBe(2);
    expect(existsSync(join(work, 'projects', 'C--x-repo', 'memory', 'banks', 'team', 'one.md'))).toBe(true);
    expect(existsSync(join(home, 'projects', 'C--x-repo', 'memory', 'banks', 'team'))).toBe(false);
    const freshKey = cwd.replace(/[^A-Za-z0-9]/g, '-');
    expect(existsSync(join(work, 'projects', freshKey, 'memory', 'banks', 'team', 'one.md'))).toBe(true);
  });

  it('reconciles a narrowed scope by removing the copies it no longer covers', { timeout: 30_000 }, () => {
    const root = bankWith(['one']);
    const { dataDir, home, work } = dataDirWithProfiles();
    const everyone = { slug: 'team', path: root, role: 'readwrite' as const, enabled: true, profiles: { kind: 'all' as const } };
    reconcileBankInstalls(everyone, dataDir);
    expect(existsSync(join(home, 'projects', 'C--x-repo', 'memory', 'banks', 'team', 'one.md'))).toBe(true);
    reconcileBankInstalls({ ...everyone, profiles: { kind: 'profiles', profileIds: ['p-work'] } }, dataDir);
    expect(existsSync(join(home, 'projects', 'C--x-repo', 'memory', 'banks', 'team'))).toBe(false);
    expect(existsSync(join(work, 'projects', 'C--x-repo', 'memory', 'banks', 'team', 'one.md'))).toBe(true);
    expect(reconcileBankInstalls({ ...everyone, enabled: false }, dataDir)).toBeNull();
    expect(existsSync(join(work, 'projects', 'C--x-repo', 'memory', 'banks', 'team'))).toBe(false);
  });

  it('uninstalls everywhere, whatever the scope was', { timeout: 30_000 }, () => {
    const root = bankWith(['one']);
    const { dataDir, home, work } = dataDirWithProfiles();
    reconcileBankInstalls({ slug: 'team', path: root, role: 'readwrite', enabled: true, profiles: { kind: 'all' } }, dataDir);
    expect(uninstallBankEverywhere('team', dataDir)).toBe(2);
    expect(existsSync(join(home, 'projects', 'C--x-repo', 'memory', 'MEMORY.md'))).toBe(false);
    expect(existsSync(join(work, 'projects', 'C--x-repo', 'memory', 'MEMORY.md'))).toBe(false);
  });
});

describe('each profile gets its own share of its memory file', () => {
  it('does not halve a single-bank account for a bank attached to another account', () => {
    // The defect this pins: the budget used to be the count of *enabled*
    // banks, so a machine with two banks halved the index of every profile —
    // including the ones carrying only one.
    const many = bankWith(Array.from({ length: 120 }, (_, i) => `entry-${String(i).padStart(3, '0')}`));
    const other = bankWith(['theirs']);
    const { dataDir, home, work } = dataDirWithProfiles();
    const registry: BankRegistryV2 = {
      version: 2,
      banks: [
        { slug: 'team', path: many, role: 'readwrite', enabled: true, profiles: { kind: 'all' } },
        { slug: 'client', path: other, role: 'readwrite', enabled: true, profiles: { kind: 'profiles', profileIds: ['p-work'] } },
      ],
      defaultSlug: 'team',
    };
    const bank = readBankAt(many, { slug: 'team' })!;
    installBankEverywhere(bank, { record: registry.banks[0]!, dataDir, registry, today: '2026-09-17' });

    const listed = (root: string): number =>
      readFileSync(join(root, 'projects', 'C--x-repo', 'memory', 'MEMORY.md'), 'utf8')
        .split('\n')
        .filter((line) => line.startsWith('- [')).length;

    // `home` carries only `team`, so it keeps the whole allowance; `work`
    // carries both and shares it.
    // One bank: the whole 170-line allowance, so every entry is listed.
    expect(listed(home)).toBe(120);
    // Two banks: half of it, and the block says how many it left on disk.
    expect(listed(work)).toBe(85);
    expect(readFileSync(join(work, 'projects', 'C--x-repo', 'memory', 'MEMORY.md'), 'utf8')).toContain('plus 35 more on disk');
  });
});
