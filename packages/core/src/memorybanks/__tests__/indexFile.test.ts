/**
 * The index the host writes for a bank, from its docs and entries, in the two
 * shapes David's banks take: org-then-project, and brand-then-system.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readBankAt } from '../formats.js';
import { renderBankIndexFile } from '../indexFile.js';
import { draftMemory, promoteBank } from '../writer.js';

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'artemis-bank-index-'));
}

function memory(name: string, extra = ''): string {
  return `---\nname: ${name}\ndescription: About ${name}\nmetadata:\n  type: reference\n  added: 2026-09-16\n${extra}---\n\nFact.\n`;
}

function projectsBank(): string {
  const dir = scratch();
  const agents = join(dir, 'projects', 'personal', 'agents');
  const homelab = join(dir, 'projects', 'personal', 'homelab');
  mkdirSync(join(agents, 'memories'), { recursive: true });
  mkdirSync(join(homelab, 'memories'), { recursive: true });
  mkdirSync(join(homelab, 'decisions'), { recursive: true });
  mkdirSync(join(dir, 'reference', 'people'), { recursive: true });
  writeFileSync(join(dir, 'BANK.md'), [
    '---',
    'name: cortex',
    'description: The primary memory.',
    'memories:',
    '  glob: projects/*/*/memories/**/*.md',
    '  scope: projects/{org}/{project}/memories/',
    'docs:',
    '  globs: ["projects/*/*/{PROJECT,HANDOFF,PLAN}.md", "reference/**/*.md"]',
    'index:',
    '  file: INDEX.md',
    '  generate: true',
    'write:',
    '  place: projects/{org}/{project}/memories/{name}.md',
    '  land: commit',
    '---',
    '',
    'Read INDEX.md first.',
  ].join('\n'));
  writeFileSync(join(agents, 'PROJECT.md'), '---\nname: agents\norg: personal\nstatus: active\nsummary: The bot fleet.\n---\n');
  writeFileSync(join(agents, 'memories', 'hermes.md'), memory('hermes', '  org: personal\n  project: agents\n'));
  writeFileSync(join(homelab, 'PROJECT.md'), '---\nname: homelab\norg: personal\nstatus: paused\nsummary: The Unraid boxes.\n---\n');
  writeFileSync(join(homelab, 'HANDOFF.md'), '# Handoff\n');
  writeFileSync(join(homelab, 'decisions', '2026-09-01-backups.md'), '# Backups\n');
  writeFileSync(join(homelab, 'memories', 'nas.md'), memory('nas', '  org: personal\n  project: homelab\n'));
  writeFileSync(join(homelab, 'memories', 'ups.md'), memory('ups', '  org: personal\n  project: homelab\n'));
  writeFileSync(join(dir, 'reference', 'conventions.md'), '---\nname: conventions\nsummary: The rules.\n---\n');
  writeFileSync(join(dir, 'reference', 'people', 'albert-go.md'), '---\nname: albert-go\ndescription: Works the brands with David.\n---\n');
  return dir;
}

describe('renderBankIndexFile', () => {
  it('lists each entry point under its first label with status, summary, path and counts', () => {
    const bank = readBankAt(projectsBank(), { slug: 'cortex' })!;
    const text = renderBankIndexFile(bank, '2026-09-16');
    expect(text).not.toBeNull();
    const lines = text!.split('\n');
    expect(lines[0]).toBe('# CORTEX INDEX - generated 2026-09-16 by Artemis memory banks. Do not edit.');
    expect(text).toContain('## personal');
    expect(text).toContain('- personal/agents - **active** - The bot fleet. -> projects/personal/agents/PROJECT.md (1 memories)');
    expect(text).toContain('- personal/homelab - **paused** - The Unraid boxes. -> projects/personal/homelab/PROJECT.md (HANDOFF, 1 decisions, 2 memories)');
    expect(text).toContain('## reference (cross-cutting facts)');
    expect(text).toContain('- reference/conventions.md - The rules.');
    expect(text).toContain('- reference/people/albert-go.md - Works the brands with David.');
    // Companions are listed under their entry point, never as lines of their own.
    expect(text).not.toContain('HANDOFF.md -');
  });

  it('answers null for a bank that keeps no generated index', () => {
    const dir = scratch();
    mkdirSync(join(dir, 'memories'));
    writeFileSync(join(dir, 'BANK.md'), '---\nname: plain\nindex: INDEX.md\n---\n');
    expect(renderBankIndexFile(readBankAt(dir, { slug: 'plain' })!)).toBeNull();
  });

  it('groups a brand-first bank by brand, with system entry points beneath', () => {
    const dir = scratch();
    mkdirSync(join(dir, 'brands', 'cool-jams', 'ads', 'memories'), { recursive: true });
    mkdirSync(join(dir, 'brands', 'sirwaggingtons', 'cloudflare', 'memories'), { recursive: true });
    writeFileSync(join(dir, 'BANK.md'), [
      '---',
      'name: brandsolidate',
      'memories:',
      '  glob: brands/*/*/memories/**/*.md',
      '  scope: brands/{brand}/{system}/',
      'docs:',
      '  glob: brands/**/{PROJECT,SYSTEM,HANDOFF}.md',
      'index: { file: INDEX.md, generate: true }',
      '---',
    ].join('\n'));
    writeFileSync(join(dir, 'brands', 'cool-jams', 'PROJECT.md'), '---\nname: cool-jams\nstatus: active\nsummary: The revenue brand.\n---\n');
    writeFileSync(join(dir, 'brands', 'cool-jams', 'HANDOFF.md'), '# h\n');
    writeFileSync(join(dir, 'brands', 'cool-jams', 'ads', 'SYSTEM.md'), '---\nname: ads\nbrand: cool-jams\nstatus: active\nsummary: Ads and Merchant Center.\n---\n');
    writeFileSync(join(dir, 'brands', 'cool-jams', 'ads', 'memories', 'geo.md'), memory('geo'));
    writeFileSync(join(dir, 'brands', 'sirwaggingtons', 'PROJECT.md'), '---\nname: sirwaggingtons\nstatus: active\nsummary: Quiet brand.\n---\n');
    writeFileSync(join(dir, 'brands', 'sirwaggingtons', 'cloudflare', 'SYSTEM.md'), '---\nname: cloudflare\nstatus: active\nsummary: Grey cloud.\n---\n');
    const text = renderBankIndexFile(readBankAt(dir, { slug: 'brandsolidate' })!, '2026-09-16')!;
    expect(text).toContain('## cool-jams');
    expect(text).toContain('- cool-jams - **active** - The revenue brand. -> brands/cool-jams/PROJECT.md (HANDOFF, 1 memories)');
    expect(text).toContain('- cool-jams/ads - **active** - Ads and Merchant Center. -> brands/cool-jams/ads/SYSTEM.md (1 memories)');
    expect(text).toContain('## sirwaggingtons');
    expect(text).toContain('- sirwaggingtons/cloudflare - **active** - Grey cloud. -> brands/sirwaggingtons/cloudflare/SYSTEM.md');
    expect(text).not.toContain('reference (');
  });
});

describe('a landing regenerates the index', () => {
  it('writes INDEX.md in the same commit as the memory', { timeout: 60_000 }, async () => {
    const root = projectsBank();
    const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x.test', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x.test' };
    execFileSync('git', ['-C', root, 'init', '-q'], { env });
    execFileSync('git', ['-C', root, 'add', '-A'], { env });
    execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'seed'], { env });
    const bank = readBankAt(root, { slug: 'cortex' })!;
    expect(existsSync(join(root, 'INDEX.md'))).toBe(false);
    expect(draftMemory(bank, { name: 'new-fact', description: 'When new', body: 'Fact dated 2026-09-16.', type: 'reference', scope: { org: 'personal', project: 'agents' } }).ok).toBe(true);
    const result = await promoteBank(bank, { gitEnv: env, now: () => new Date('2026-09-16T00:00:00Z') });
    expect(result.outcome?.kind).toBe('commit');
    const index = readFileSync(join(root, 'INDEX.md'), 'utf8');
    expect(index).toContain('- personal/agents - **active** - The bot fleet. -> projects/personal/agents/PROJECT.md (2 memories)');
    const shown = execFileSync('git', ['-C', root, 'show', '--stat', '--oneline', 'HEAD'], { encoding: 'utf8', env });
    expect(shown).toContain('INDEX.md');
    expect(shown).toContain('new-fact.md');
  });
});
