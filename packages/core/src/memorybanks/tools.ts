/**
 * The memory tools: how an agent reads and writes the banks from inside a run.
 *
 * One in-process MCP server, built per run by the host through the same seam
 * as the browser and task tools (`agentToolServers`), so a run on any provider
 * that takes host tools — Claude, or a local model through Artemis's own MCP
 * client — reaches the banks the run's profile carries. No shell, no Python,
 * no PATH: the tools are what replaces `cerebro draft` and `cerebro promote`
 * in the prompt, and what makes a bank reachable from a provider that has
 * neither.
 *
 * Five tools, deliberately few:
 *
 *  - `memory_search` — find entries by what they are about, across the banks.
 *  - `memory_read` — one entry in full.
 *  - `memory_draft` — validate and queue a memory. Refuses on warnings as
 *    well as errors, with the reasons, because the bank's CI would.
 *  - `memory_promote` — file the queued drafts and land them the way the
 *    bank asked: a pull request (merged and verified when the bank says so),
 *    a commit, or a refusal for a read-only bank.
 *  - `memory_retire` — remove an entry that has stopped being true.
 *
 * Scope is the run's: the server closes over the profile and the working
 * directory, so a bank attached to another account is not offered, and the
 * model cannot name one.
 */

import { createSdkMcpServer, tool, type McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { readBankAt } from './formats.js';
import type { Bank } from './model.js';
import { readRegistryV2, scopeCoversProfile, writeRegistryV2, type BankRecord } from './registryV2.js';
import { searchBanks } from './search.js';
import { draftMemory, promoteBank, refreshBank, retireMemory, type LandingDeps } from './writer.js';

/** The server's name: its tools are addressed as `mcp__artemisMemory__<tool>`. */
export const MEMORY_TOOL_SERVER = 'artemisMemory';

export interface MemoryToolServerOptions {
  /** The host's data directory: where `memory-banks.json` lives. */
  readonly dataDir: string;
  /** The CLI's registry to stay in step with, when the machine keeps one. */
  readonly cliRegistryPath?: string;
  /** The run's profile. A bank scoped away from it is not offered. */
  readonly profileId?: string;
  /** The run's working directory, for `applies_to` defaults in a later phase. */
  readonly cwd?: string;
  /** How a landing authenticates. See {@link LandingDeps}. */
  readonly landing?: LandingDeps;
  readonly log?: (line: string) => void;
  /** Injectable clock, for tests. */
  readonly today?: () => string;
}

interface LoadedBank {
  readonly record: BankRecord;
  readonly bank: Bank;
}

function text(body: string, isError = false): { content: { type: 'text'; text: string }[]; isError?: boolean } {
  return { content: [{ type: 'text', text: body }], ...(isError ? { isError: true } : {}) };
}

/** The banks this run may see: enabled, in scope, on disk, read fresh on every call. */
export function loadRunBanks(options: MemoryToolServerOptions): LoadedBank[] {
  const where = { dataDir: options.dataDir, ...(options.cliRegistryPath === undefined ? {} : { cliRegistryPath: options.cliRegistryPath }) };
  const { registry, dirty } = readRegistryV2(where);
  if (dirty) {
    try {
      writeRegistryV2(where, registry);
    } catch {
      // A courtesy write; this call already holds the answer.
    }
  }
  const loaded: LoadedBank[] = [];
  for (const record of registry.banks) {
    if (!record.enabled || !scopeCoversProfile(record.profiles, options.profileId)) continue;
    const bank = readBankAt(record.path, { slug: record.slug });
    if (bank !== null) loaded.push({ record, bank });
  }
  return loaded;
}

function writable(loaded: readonly LoadedBank[]): LoadedBank[] {
  return loaded.filter(({ record, bank }) => record.role === 'readwrite' && bank.landing !== 'none');
}

/** Pick the bank a call addresses: the named one, else the only writable one. */
function pick(loaded: readonly LoadedBank[], slug: string | undefined, forWriting: boolean): LoadedBank | string {
  const pool = forWriting ? writable(loaded) : loaded;
  if (pool.length === 0) {
    return forWriting ? 'no writable memory bank reaches this run' : 'no memory bank reaches this run';
  }
  if (slug !== undefined && slug.length > 0) {
    const found = pool.find(({ record }) => record.slug === slug);
    return found ?? `no ${forWriting ? 'writable ' : ''}bank called ${slug} reaches this run; the banks are: ${pool.map(({ record }) => record.slug).join(', ')}`;
  }
  if (pool.length === 1) return pool[0]!;
  return `several banks reach this run — name one with \`bank\`: ${pool.map(({ record }) => record.slug).join(', ')}`;
}

function filingHint(bank: Bank): string {
  if (bank.memories.levels.length === 0) return 'This bank files flat: no scope labels are needed.';
  return `This bank files by ${bank.memories.levels.join(', then ')}: pass \`scope\` with those labels, naming folders that already exist.`;
}

function describeBanks(loaded: readonly LoadedBank[]): string {
  return loaded
    .map(({ record, bank }) => {
      const role = record.role === 'readonly' || bank.landing === 'none' ? 'read-only' : `read-write, lands by ${bank.landing}`;
      const about = bank.description === null ? '' : ` — ${bank.description}`;
      return `- ${record.slug} (${role}; ${bank.entries.length} entries; ${bank.memories.levels.length === 0 ? 'flat' : `filed by ${bank.memories.levels.join('/')}`})${about}`;
    })
    .join('\n');
}

/** Build the tool server for one run. */
export function memoryToolServer(options: MemoryToolServerOptions): McpServerConfig {
  return createSdkMcpServer({
    name: MEMORY_TOOL_SERVER,
    version: '1',
    instructions:
      "The team's memory banks: shared, agent-maintained facts. Search before guessing about " +
      'conventions, ownership or past decisions; draft what you learn that a teammate would need; ' +
      'promote to land it through the bank’s own review path.',
    tools: memoryTools(options),
  });
}

/** The tool definitions, addressable for tests. */
export function memoryTools(options: MemoryToolServerOptions) {
  const log = options.log ?? (() => undefined);
  const today = options.today ?? (() => new Date().toISOString().slice(0, 10));

  return [
    tool(
      'memory_search',
      'Find memory-bank entries about a topic, a system, a repository or a decision. Use it before ' +
        'guessing about team conventions or past decisions, and before drafting, to find an existing ' +
        'entry to update instead of adding a second one. Returns the best matches with their bank, ' +
        'name, description and a snippet; read one in full with memory_read.',
      {
        query: z.string().describe('Words to look for: a system name, a repository, an error, a topic.'),
        bank: z.string().optional().describe('Limit to one bank by its name. Omit to search every bank this run carries.'),
        limit: z.number().int().min(1).max(25).optional().describe('How many results. Default 8.'),
      },
      // eslint-disable-next-line @typescript-eslint/require-await -- the seam is async
      async ({ query, bank, limit }) => {
        const loaded = loadRunBanks(options);
        if (loaded.length === 0) return text('No memory bank reaches this run.', true);
        const pool = bank === undefined ? loaded : loaded.filter(({ record }) => record.slug === bank);
        if (pool.length === 0) return text(`No bank called ${bank} reaches this run. Banks:\n${describeBanks(loaded)}`, true);
        const hits = searchBanks(pool.map(({ record, bank: b }) => ({ slug: record.slug, bank: b })), query, limit ?? 8);
        if (hits.length === 0) return text(`Nothing in ${pool.map(({ record }) => record.slug).join(', ')} matches "${query}".\n\nBanks this run carries:\n${describeBanks(loaded)}`);
        const lines = hits.map((hit) => {
          const scope = Object.entries(hit.entry.scope).map(([key, value]) => `${key}=${value}`).join(' ');
          return `- ${hit.slug}/${hit.entry.name}${scope.length > 0 ? ` [${scope}]` : ''} — ${hit.entry.description}\n  ${hit.snippet}`;
        });
        return text(`${String(hits.length)} match(es) for "${query}":\n${lines.join('\n')}`);
      },
    ),

    tool(
      'memory_read',
      'Read one memory-bank entry in full, by bank and name (as memory_search lists them).',
      {
        name: z.string().describe('The entry name, kebab-case.'),
        bank: z.string().optional().describe('The bank. Omit when only one bank reaches this run.'),
      },
      // eslint-disable-next-line @typescript-eslint/require-await -- the seam is async
      async ({ name, bank }) => {
        const loaded = loadRunBanks(options);
        const candidates = bank === undefined ? loaded : loaded.filter(({ record }) => record.slug === bank);
        for (const { record, bank: b } of candidates) {
          const entry = b.entries.find((candidate) => candidate.name === name);
          if (entry === undefined) continue;
          const scope = Object.entries(entry.scope).map(([key, value]) => `${key}: ${value}`).join(', ');
          return text(
            `# ${entry.title} (${record.slug}/${entry.file})\n` +
              `${entry.description}\n` +
              `${scope.length > 0 ? `Filed under ${scope}. ` : ''}${entry.type === null ? '' : `Type ${entry.type}. `}${entry.added === null ? '' : `Added ${entry.added}.`}\n\n` +
              entry.body,
          );
        }
        return text(`No entry named ${name}${bank === undefined ? '' : ` in ${bank}`}. Try memory_search.`, true);
      },
    ),

    tool(
      'memory_draft',
      'Validate and queue a new memory, or an update to an existing one (same name), in a team memory ' +
        'bank. One fact per memory; the description is a retrieval hook ("when is this relevant?"), not ' +
        'a title; absolute dates; never a secret or personal detail. Refused with reasons when the bank’s ' +
        'gates would refuse it — fix and call again. Nothing lands until memory_promote.',
      {
        name: z.string().describe('kebab-case slug. Re-use an existing name to update that entry.'),
        description: z.string().describe('When is this relevant? Under 160 characters.'),
        body: z.string().describe('The fact, in markdown. feedback and project types need **Why:** and **How to apply:** lines.'),
        type: z.string().optional().describe('For cerebro-schema banks: user, feedback, project or reference.'),
        bank: z.string().optional().describe('Which bank. Omit when only one writable bank reaches this run.'),
        scope: z.record(z.string(), z.string()).optional().describe('The filing labels the bank uses, e.g. {"org":"personal","project":"homelab"} or {"brand":"cool-jams","system":"ads"}. The folders must already exist.'),
        applies_to: z.array(z.string()).optional().describe('Repository directory names this fact is specific to. Omit when it holds across repos.'),
        author: z.string().optional().describe('Who recorded it, when known.'),
      },
      // eslint-disable-next-line @typescript-eslint/require-await -- the seam is async
      async ({ name, description, body, type, bank, scope, applies_to, author }) => {
        const loaded = loadRunBanks(options);
        const picked = pick(loaded, bank, true);
        if (typeof picked === 'string') return text(picked, true);
        const result = draftMemory(picked.bank, {
          name,
          description,
          body,
          ...(type === undefined ? {} : { type }),
          ...(scope === undefined ? {} : { scope }),
          ...(applies_to === undefined ? {} : { appliesTo: applies_to }),
          ...(author === undefined ? {} : { author }),
          today: today(),
        });
        if (!result.ok) {
          const reasons = [...result.problems, ...result.warnings].map((reason) => `- ${reason}`).join('\n');
          return text(`Refused — nothing was written. Fix each line and call memory_draft again:\n${reasons}\n\n${filingHint(picked.bank)}`, true);
        }
        return text(
          `Queued ${result.file} in ${picked.record.slug}; it will be filed at ${result.destination ?? '?'}` +
            `${result.replaces === null ? '' : `, replacing ${result.replaces}`}. Call memory_promote to land it.`,
        );
      },
    ),

    tool(
      'memory_promote',
      'File every queued draft in a bank and land the change the way the bank asks: a pull request ' +
        '(merged and verified when the bank auto-merges), or a commit. Reports what landed and what was rejected.',
      {
        bank: z.string().optional().describe('Which bank. Omit when only one writable bank reaches this run.'),
      },
      async ({ bank }) => {
        const loaded = loadRunBanks(options);
        const picked = pick(loaded, bank, true);
        if (typeof picked === 'string') return text(picked, true);
        let result;
        try {
          result = await promoteBank(picked.bank, { ...(options.landing ?? {}), log });
        } catch (error) {
          return text(`Promote failed: ${error instanceof Error ? error.message : String(error)}`, true);
        }
        const parts: string[] = [];
        if (result.landed.length > 0 && result.outcome !== null) parts.push(`Landed ${result.landed.join(', ')}: ${result.outcome.detail}.`);
        for (const item of result.rejected) parts.push(`Rejected ${item.name} (renamed .rejected in inbox/): ${item.reasons.join('; ')}`);
        if (parts.length === 0) parts.push('Nothing queued in inbox/. Draft first with memory_draft.');
        refreshBank(picked.bank, picked.record.slug);
        return text(parts.join('\n'), result.landed.length === 0 && result.rejected.length > 0);
      },
    ),

    tool(
      'memory_retire',
      'Remove a memory that has stopped being true, landing the removal the way the bank asks.',
      {
        name: z.string().describe('The entry name.'),
        reason: z.string().optional().describe('Why, for the commit message.'),
        bank: z.string().optional().describe('Which bank. Omit when only one writable bank reaches this run.'),
      },
      async ({ name, reason, bank }) => {
        const loaded = loadRunBanks(options);
        const picked = pick(loaded, bank, true);
        if (typeof picked === 'string') return text(picked, true);
        try {
          const outcome = await retireMemory(picked.bank, name, reason, { ...(options.landing ?? {}), log });
          return text(`Retire ${name} in ${picked.record.slug}: ${outcome.detail}.`, outcome.kind === 'nothing');
        } catch (error) {
          return text(`Retire failed: ${error instanceof Error ? error.message : String(error)}`, true);
        }
      },
    ),
  ];
}
