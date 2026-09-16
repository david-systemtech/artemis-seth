/**
 * Writing to a bank: draft, promote, retire — and landing the result the way
 * the bank asked for.
 *
 * The shape is the `cerebro` CLI's, kept because every bank's conventions and
 * every agent's habits are built on it. A **draft** is validated and written
 * to `inbox/<name>.md`; nothing else moves. A **promote** validates each
 * draft again, files it where the bank's format says a memory of that scope
 * lives, and lands the change: as a pull request through the forge's API (and
 * merges it when the bank says `merge: auto`, then checks the file is really
 * on the base branch), as a plain commit, or not at all for a bank that only
 * consumes. A **retire** removes one entry the same way. A draft that fails
 * validation is renamed `.rejected` beside its reasons, never silently
 * dropped.
 *
 * Landing happens in a detached worktree, as the CLI does it, so a dirty
 * checkout — a person mid-edit, another session's draft — is never committed
 * by accident and never blocks the landing.
 *
 * This module spawns git and calls forges. Nothing here is on the path of a
 * run start; it runs when an agent calls a memory tool.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import { defaultBranch, detectForge, fileOnBranch, gitCredentialFill, mergePullRequest, openPullRequest, type Forge, type ForgeCredential } from './forge.js';
import { readBank, readBankAt } from './formats.js';
import { parseFrontmatter, serializeFrontmatter } from './frontmatter.js';
import type { Bank, BankEntry } from './model.js';
import { CEREBRO_SCHEMA, checkEntry, SLUG_PATTERN } from './schema.js';
import { hasRemote } from './sync.js';

const execFileAsync = promisify(execFile);

/* -------------------------------------------------------------------------- */
/* Rendering an entry the way the bank's own gate reads it                    */
/* -------------------------------------------------------------------------- */

/** The CLI's own quoting: double quotes when the value would otherwise misread. */
function quoteForCli(value: string): string {
  const risky = value.includes(': ') || value.includes(' #') || value.includes('"') || /^["'{[&*!|>%@`]/.test(value);
  return risky ? `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : value;
}

/**
 * The text of a new entry.
 *
 * For the `cerebro` schema, rendered the way the CLI renders one — `name`,
 * `description`, then a `metadata:` block with `type` first — because the
 * bank's CI reads the file with the CLI's hand-rolled parser, which knows
 * double quotes and nothing else. For any other schema, ordinary YAML.
 */
export function renderEntry(bank: Bank, input: { readonly name: string; readonly description: string; readonly body: string; readonly metadata: Readonly<Record<string, string>> }): string {
  const body = input.body.trim();
  if (bank.memories.schema.typeKey === CEREBRO_SCHEMA.typeKey && bank.memories.schema.strictKeys) {
    const lines = ['---', `name: ${input.name}`, `description: ${quoteForCli(input.description)}`, 'metadata:'];
    const keys = ['type', ...Object.keys(input.metadata).filter((key) => key !== 'type')];
    for (const key of keys) {
      const value = input.metadata[key];
      if (value === undefined) continue;
      lines.push(`  ${key}: ${quoteForCli(value)}`);
    }
    lines.push('---', '', body, '');
    return lines.join('\n');
  }
  const data: Record<string, unknown> = { name: input.name, description: input.description };
  const typeKey = bank.memories.schema.typeKey;
  const nested = typeKey !== null && typeKey.startsWith('metadata.');
  if (nested) data['metadata'] = { ...input.metadata };
  else Object.assign(data, input.metadata);
  return serializeFrontmatter(data, body);
}

/* -------------------------------------------------------------------------- */
/* Where an entry goes                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The bank-relative path a new entry is filed at, or the reason it cannot be.
 *
 * The template comes from the bank: `projects/{org}/{project}/memories/{name}.md`
 * for a cortex-shaped bank, whatever the manifest's `write.place` says for a
 * manifest bank, `memories/{name}.md` for a flat one. Every `{label}` in it
 * but `{name}` must be supplied, and the directory it names must exist — the
 * CLI's rule that a memory never invents a project, kept for every shape.
 */
export function placeFor(
  bank: Bank,
  name: string,
  scope: Readonly<Record<string, string>>,
): { path: string; problem: null } | { path: null; problem: string } {
  const template = bank.memories.place ?? 'memories/{name}.md';
  const labels = [...template.matchAll(/\{([a-z][a-z0-9_-]*)\}/g)].map((match) => match[1] ?? '').filter((label) => label !== 'name');
  const missing = labels.filter((label) => !(label in scope) || (scope[label] ?? '').length === 0);
  if (missing.length > 0) {
    return { path: null, problem: `this bank files by ${labels.join(', then ')}; ${missing.map((label) => `\`${label}\``).join(' and ')} not given` };
  }
  for (const label of labels) {
    const value = scope[label] ?? '';
    if (!SLUG_PATTERN.test(value)) return { path: null, problem: `${label} must be kebab-case: ${value}` };
  }
  let path = template;
  for (const label of labels) path = path.split(`{${label}}`).join(scope[label] ?? '');
  path = path.split('{name}').join(name);
  const directory = dirname(path);
  if (directory !== '.' && !existsSync(join(bank.root, directory))) {
    const folder = directory.replace(/\/memories$/, '');
    return { path: null, problem: `no ${labels.length > 0 ? labels.join('/') : 'folder'} ${folder} in this bank — never invent one; pick from the bank's existing folders` };
  }
  return { path, problem: null };
}

/* -------------------------------------------------------------------------- */
/* Draft                                                                      */
/* -------------------------------------------------------------------------- */

export interface DraftInput {
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly type?: string;
  readonly scope?: Readonly<Record<string, string>>;
  readonly appliesTo?: readonly string[];
  readonly author?: string;
  /** ISO date. Defaults to today. */
  readonly today?: string;
}

export interface DraftResult {
  readonly ok: boolean;
  /** `inbox/<name>.md` when written. */
  readonly file: string | null;
  /** Where the entry will be filed on promote. */
  readonly destination: string | null;
  readonly problems: readonly string[];
  readonly warnings: readonly string[];
  /** An existing entry of the same name that the promote will replace. */
  readonly replaces: string | null;
}

/**
 * Validate and queue a memory. Errors *and* warnings refuse it — the bank's
 * CI validates strictly, so a memory that merely warns would open a pull
 * request that can never merge, and the message names what to change.
 */
export function draftMemory(bank: Bank, input: DraftInput): DraftResult {
  const problems: string[] = [];
  const name = input.name.trim();
  if (!SLUG_PATTERN.test(name)) problems.push('name must be kebab-case: lowercase letters, digits and hyphens');
  const scope = input.scope ?? {};
  const placed = placeFor(bank, name, scope);
  if (placed.problem !== null) problems.push(placed.problem);

  const metadata: Record<string, string> = {};
  if (input.type !== undefined && input.type.length > 0) metadata['type'] = input.type;
  metadata['added'] = input.today ?? new Date().toISOString().slice(0, 10);
  if (input.author !== undefined && input.author.trim().length > 0) metadata['author'] = input.author.trim();
  for (const level of bank.memories.levels) {
    const value = scope[level];
    if (value !== undefined && value.length > 0) metadata[level] = value;
  }
  if (input.appliesTo !== undefined && input.appliesTo.length > 0) metadata['applies_to'] = input.appliesTo.join(', ');

  const text = renderEntry(bank, { name, description: input.description.trim(), body: input.body, metadata });
  const checked = checkEntry(parseFrontmatter(text), name, bank.memories.schema);
  problems.push(...checked.problems);
  const warnings = [...checked.warnings];
  if (problems.length > 0 || warnings.length > 0) {
    return { ok: false, file: null, destination: placed.path, problems, warnings, replaces: null };
  }
  const inbox = join(bank.root, 'inbox');
  mkdirSync(inbox, { recursive: true });
  writeFileSync(join(inbox, `${name}.md`), text, 'utf8');
  const existing = bank.entries.find((entry) => entry.name === name);
  return {
    ok: true,
    file: `inbox/${name}.md`,
    destination: placed.path,
    problems: [],
    warnings: [],
    replaces: existing === undefined ? null : existing.file,
  };
}

/* -------------------------------------------------------------------------- */
/* Landing                                                                    */
/* -------------------------------------------------------------------------- */

export interface LandingDeps {
  /** A credential for the forge, when the host holds one. Falls back to `git credential fill`. */
  readonly credential?: (forge: Forge) => Promise<ForgeCredential | null>;
  /** Extra environment for git (a credential helper, `GIT_TERMINAL_PROMPT`). */
  readonly gitEnv?: Readonly<Record<string, string>>;
  readonly log?: (line: string) => void;
  /** Injectable for tests. */
  readonly now?: () => Date;
}

export interface LandingOutcome {
  readonly kind: 'pull-request' | 'commit' | 'nothing';
  readonly detail: string;
  readonly pullRequest?: { readonly number: number; readonly url: string; readonly merged: boolean; readonly verified: boolean };
  readonly commit?: string;
  readonly branch?: string;
}

async function git(root: string, args: readonly string[], env: Readonly<Record<string, string>> = {}, timeoutMs = 60_000): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', root, ...args], {
    timeout: timeoutMs,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
  });
  return stdout;
}

function gitAuthArgs(forge: Forge | null, credential: ForgeCredential | null): string[] {
  if (forge === null || credential === null) return [];
  // Sent for this command only, never written to the checkout's config.
  const basic = Buffer.from(`${credential.username}:${credential.token}`, 'utf8').toString('base64');
  return ['-c', `http.${forge.scheme}://${forge.host}/.extraheader=Authorization: Basic ${basic}`];
}

/**
 * Apply a set of file changes to the bank and land them.
 *
 * `mutate` writes into whichever tree is being committed: a detached worktree
 * on the base branch for a pull request, the checkout itself for a commit.
 * Paths are bank-relative; `null` content means delete.
 */
export async function landChanges(
  bank: Bank,
  input: {
    readonly message: string;
    readonly branchSlug: string;
    readonly changes: readonly { readonly path: string; readonly content: string | null }[];
  },
  deps: LandingDeps = {},
): Promise<LandingOutcome> {
  const log = deps.log ?? (() => undefined);
  if (bank.landing === 'none') return { kind: 'nothing', detail: 'this bank is read-only: it lands nothing' };
  if (input.changes.length === 0) return { kind: 'nothing', detail: 'nothing to land' };

  const apply = (tree: string): void => {
    for (const change of input.changes) {
      const target = resolve(tree, change.path);
      if (!target.startsWith(resolve(tree) + sep)) throw new Error(`refusing to write outside the bank: ${change.path}`);
      if (change.content === null) {
        if (existsSync(target)) unlinkSync(target);
      } else {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, change.content, 'utf8');
      }
    }
  };

  const remote = hasRemote(bank.root);
  const remoteUrl = remote ? await originUrl(bank.root) : null;
  const forge = remoteUrl === null ? null : detectForge(remoteUrl);
  const wantsPullRequest = bank.landing === 'pull-request' && remote;

  if (!wantsPullRequest) {
    apply(bank.root);
    const paths = input.changes.map((change) => change.path);
    await git(bank.root, ['add', '-A', '--', ...paths]);
    await git(bank.root, ['commit', '-q', '-m', input.message, '--', ...paths]);
    const sha = (await git(bank.root, ['rev-parse', '--short', 'HEAD'])).trim();
    let detail = `committed ${sha}`;
    if (remote) {
      const credential = forge === null ? null : await resolveCredential(forge, deps);
      try {
        await git(bank.root, [...gitAuthArgs(forge, credential), 'push', '-q'], deps.gitEnv ?? {}, 120_000);
        detail += ' and pushed';
      } catch (error) {
        detail += `; push failed: ${lastLine(error)}`;
      }
    }
    return { kind: 'commit', detail, commit: sha };
  }

  const base = await defaultBranch(bank.root);
  const stamp = (deps.now?.() ?? new Date()).toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const branch = `memory-${stamp}-${input.branchSlug}`.slice(0, 60);
  const credential = forge === null ? null : await resolveCredential(forge, deps);
  const auth = gitAuthArgs(forge, credential);
  const env = deps.gitEnv ?? {};

  try {
    await git(bank.root, [...auth, 'fetch', '-q', 'origin', base], env, 120_000);
  } catch (error) {
    log(`fetch before landing failed: ${lastLine(error)}`);
  }
  const scratch = mkdtempSync(join(tmpdir(), 'artemis-bank-land-'));
  const worktree = join(scratch, 'wt');
  try {
    await git(bank.root, ['worktree', 'add', '-q', '--detach', worktree, `origin/${base}`]);
    apply(worktree);
    const paths = input.changes.map((change) => change.path);
    await git(worktree, ['add', '-A', '--', ...paths]);
    await git(worktree, ['commit', '-q', '-m', input.message, '--', ...paths]);
    const sha = (await git(worktree, ['rev-parse', '--short', 'HEAD'])).trim();
    await git(worktree, [...auth, 'push', '-q', 'origin', `HEAD:refs/heads/${branch}`], env, 120_000);

    if (forge === null) {
      return { kind: 'pull-request', detail: `pushed ${branch}; the remote is not a forge this host can open a pull request on`, branch, commit: sha };
    }
    let pr;
    try {
      pr = await openPullRequest(forge, credential, {
        head: branch,
        base,
        title: input.message,
        body: 'Automated memory change from an agent session; validated by Artemis memory banks.',
      });
    } catch (error) {
      return { kind: 'pull-request', detail: `pushed ${branch}; ${lastLine(error)} — open the pull request by hand`, branch, commit: sha };
    }
    if (bank.merge !== 'auto') {
      return { kind: 'pull-request', detail: `opened pull request #${String(pr.number)} for review`, branch, commit: sha, pullRequest: { ...pr, merged: false, verified: false } };
    }
    const merged = await mergePullRequest(forge, credential, pr.number);
    if (!merged.merged) {
      return { kind: 'pull-request', detail: `opened pull request #${String(pr.number)}; it did not merge (${merged.detail}) and stays open`, branch, commit: sha, pullRequest: { ...pr, merged: false, verified: false } };
    }
    // A merge that answered 200 is not proof the file landed — see the cortex
    // memory `cortex-verify-after-merge`. Ask the forge for the file on the
    // base branch, a few times, before believing it.
    const added = input.changes.filter((change) => change.content !== null).map((change) => change.path);
    let verified = added.length === 0;
    for (let attempt = 0; attempt < 5 && !verified; attempt += 1) {
      if (attempt > 0) await new Promise((resolveWait) => setTimeout(resolveWait, 2000));
      const checks = await Promise.all(added.map((path) => fileOnBranch(forge, credential, path, base)));
      verified = checks.every(Boolean);
    }
    try {
      await git(bank.root, [...auth, 'pull', '-q', '--ff-only'], env, 120_000);
    } catch (error) {
      log(`pull after merge failed: ${lastLine(error)}`);
    }
    return {
      kind: 'pull-request',
      detail: verified
        ? `pull request #${String(pr.number)} merged and verified on ${base}`
        : `pull request #${String(pr.number)} merged, but the files are not yet visible on ${base} — check the forge`,
      branch,
      commit: sha,
      pullRequest: { ...pr, merged: true, verified },
    };
  } finally {
    try {
      await git(bank.root, ['worktree', 'remove', '--force', worktree]);
    } catch {
      // Best effort; the scratch directory goes regardless.
    }
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function resolveCredential(forge: Forge, deps: LandingDeps): Promise<ForgeCredential | null> {
  if (deps.credential !== undefined) {
    const held = await deps.credential(forge);
    if (held !== null) return held;
  }
  return gitCredentialFill(forge);
}

async function originUrl(root: string): Promise<string | null> {
  try {
    const url = (await git(root, ['remote', 'get-url', 'origin'])).trim();
    return url.length > 0 ? url : null;
  } catch {
    return null;
  }
}

function lastLine(error: unknown): string {
  const raw = error as { stderr?: unknown; message?: unknown };
  const said = typeof raw.stderr === 'string' && raw.stderr.trim().length > 0 ? raw.stderr : String(raw.message ?? error);
  const lines = said.split('\n').filter((line) => line.trim().length > 0);
  return (lines.at(-1) ?? 'failed').trim().slice(0, 240);
}

/* -------------------------------------------------------------------------- */
/* Promote and retire                                                         */
/* -------------------------------------------------------------------------- */

export interface PromoteResult {
  readonly landed: readonly string[];
  readonly rejected: readonly { readonly name: string; readonly reasons: readonly string[] }[];
  readonly outcome: LandingOutcome | null;
}

/** File every queued draft and land the lot. */
export async function promoteBank(bank: Bank, deps: LandingDeps = {}): Promise<PromoteResult> {
  const inbox = join(bank.root, 'inbox');
  const queued = existsSync(inbox) ? readdirSync(inbox).filter((file) => file.endsWith('.md')).sort() : [];
  const landed: string[] = [];
  const rejected: { name: string; reasons: string[] }[] = [];
  const changes: { path: string; content: string | null }[] = [];
  const names: string[] = [];
  for (const file of queued) {
    const name = file.slice(0, -3);
    const text = readFileSync(join(inbox, file), 'utf8');
    const document = parseFrontmatter(text);
    const checked = checkEntry(document, name, bank.memories.schema);
    const scope: Record<string, string> = {};
    for (const level of bank.memories.levels) {
      const value = document.data === null ? undefined : (document.data['metadata'] as Record<string, unknown> | undefined)?.[level] ?? document.data[level];
      if (typeof value === 'string') scope[level] = value;
    }
    const placed = placeFor(bank, name, scope);
    const reasons = [...checked.problems, ...checked.warnings, ...(placed.problem === null ? [] : [placed.problem])];
    if (reasons.length > 0 || placed.path === null) {
      rejected.push({ name, reasons });
      renameSync(join(inbox, file), join(inbox, `${file}.rejected`));
      continue;
    }
    // A slug that moved folders updates in place: the old file goes.
    const existing = bank.entries.find((entry) => entry.name === name);
    if (existing !== undefined && existing.file !== placed.path) changes.push({ path: existing.file, content: null });
    changes.push({ path: placed.path, content: text.replace(/\r\n?/g, '\n') });
    names.push(name);
  }
  if (names.length === 0) return { landed, rejected, outcome: null };
  const updates = names.filter((name) => bank.entries.some((entry) => entry.name === name));
  const additions = names.filter((name) => !updates.includes(name));
  const message =
    'memory: ' +
    [additions.length > 0 ? `add ${additions.join(', ')}` : '', updates.length > 0 ? `update ${updates.join(', ')}` : '']
      .filter((part) => part.length > 0)
      .join('; ');
  const outcome = await landChanges(bank, { message, branchSlug: names[0] ?? 'promote', changes }, deps);
  if (outcome.kind !== 'nothing') {
    for (const file of queued) {
      const path = join(inbox, file);
      if (existsSync(path) && names.includes(file.slice(0, -3))) unlinkSync(path);
    }
    landed.push(...names);
  }
  return { landed, rejected, outcome };
}

/** Remove one entry, landing the removal the way the bank asks. */
export async function retireMemory(bank: Bank, name: string, reason: string | undefined, deps: LandingDeps = {}): Promise<LandingOutcome | { kind: 'nothing'; detail: string }> {
  const entry: BankEntry | undefined = bank.entries.find((candidate) => candidate.name === name);
  if (entry === undefined) return { kind: 'nothing', detail: `no memory named ${name} in this bank` };
  const message = `memory: retire ${name}${reason === undefined || reason.trim().length === 0 ? '' : ` (${reason.trim()})`}`;
  return landChanges(bank, { message, branchSlug: `retire-${name}`, changes: [{ path: entry.file, content: null }] }, deps);
}

/** Re-read a bank after a write, so the next call sees what landed. */
export function refreshBank(bank: Bank, slug: string): Bank {
  return readBankAt(bank.root, { slug }) ?? readBank(bank);
}
