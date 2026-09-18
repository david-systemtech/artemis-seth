/**
 * Skills: what a machine can offer a session, and which of them are always on.
 * ============================================================================
 *
 * A skill is a folder holding a `SKILL.md` — a name, a description, and a body
 * of instructions the agent loads when it decides the skill applies, or when
 * the user types its slash command. Artemis already delivers them to a run (see
 * core's `content/bridge.ts`); what it had no answer for is the two questions a
 * person asks next:
 *
 *  1. **What have I got?** Skills arrive from folders on disk, and until this
 *     existed the only way to find out which ones a session would offer was to
 *     start one and type `/`. {@link SkillInfo} is one row of the answer.
 *  2. **Can this one just always apply?** A skill is normally chosen by the
 *     model from its description, which is right for "how to cut a release" and
 *     wrong for "how I want prose written". {@link AlwaysOnSkill} is that
 *     choice: the skill's body is appended to the system prompt of every run it
 *     applies to, exactly the way a standing instruction is.
 *
 * ---------------------------------------------------------------------------
 * WHY ALWAYS-ON IS STORED BY NAME AND COMPOSED WHERE THE RUN EXECUTES
 * ---------------------------------------------------------------------------
 *
 * The stored choice is a *name* and a scope, never the skill's text. The text
 * belongs to the folder, which a synced source may update tonight, and a copy
 * frozen into a settings file is a copy that silently stops improving — the
 * argument `AgentPrompt.builtIn` makes for Artemis's own prompts.
 *
 * And the name is resolved on the machine the run executes on. A skill's body
 * points at files beside it — a checklist, a script — so the text has to be
 * composed with the directory *that* machine keeps it in. For a local run that
 * is here; for a run on an Artemis server it is the server, which is why a
 * served request is to carry names rather than prose — and until the server
 * composes them, a served run is given none. The memory banks' prompt already
 * works this way, for the same reason: text naming one machine's paths is
 * wrong on every other machine.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT A ROW IN THE PROMPT LIBRARY
 * ---------------------------------------------------------------------------
 *
 * It composes into the same place and it is scoped the same way, so the
 * tempting design is a new kind of `AgentPrompt`. It is kept apart because the
 * prompt library is a document of the user's *own prose*, edited as prose, and
 * every control in its pane — the editor, "take over this text", the character
 * limit — is about authoring. An always-on skill has no text to author. What it
 * shares with a standing prompt is {@link AgentPromptScope}, which is reused
 * rather than reinvented.
 */

import { scopeCovers, type AgentPromptScope } from './agentPrompts.js';
import type { ProfileId } from './ids.js';

/* -------------------------------------------------------------------------- */
/* One skill, as a machine reports it                                         */
/* -------------------------------------------------------------------------- */

/**
 * Where a skill's folder is, in the terms a person would use.
 *
 *  - `profile`: under an account's own config directory, so only that account's
 *    sessions are offered it. A list, because accounts can share one folder —
 *    the shared-`~/.claude` arrangement links every Claude profile's `skills` at
 *    the same place — and a row naming one of four accounts that all have the
 *    skill would read as the other three lacking it.
 *  - `machine`: under `~/.agents/skills`, the vendor-neutral folder every
 *    Claude and Codex account on the machine reads.
 *  - `source`: inside a repository Artemis keeps cloned and pulled — see
 *    {@link SkillSource}. Offered to every account, like `machine`.
 */
export type SkillOrigin =
  | { readonly kind: 'profile'; readonly profileIds: readonly ProfileId[] }
  | { readonly kind: 'machine' }
  | { readonly kind: 'source'; readonly sourceId: string };

/** One skill a session on this machine would be offered. */
export interface SkillInfo {
  /**
   * The folder's name. The skill's identity on this machine: what the slash
   * command is built from, what {@link AlwaysOnSkill.name} refers to, and what
   * decides which of two same-named skills wins.
   */
  readonly name: string;
  /**
   * What the skill says it is for, from its frontmatter. Empty when it says
   * nothing — which also means the model has nothing to choose it by.
   */
  readonly description: string;
  readonly origin: SkillOrigin;
  /** The folder, absolute, on the machine that reported it. */
  readonly dir: string;
  /**
   * The model may pick this skill by itself. False when the skill's frontmatter
   * sets `disable-model-invocation: true`, which leaves the slash command as
   * the only way in.
   */
  readonly modelInvocable: boolean;
  /** It appears in the `/` menu. False for `user-invocable: false`. */
  readonly userInvocable: boolean;
  /**
   * How much of the body a run is given, in characters: all of it, or
   * {@link SKILL_LIMITS.body} for one long enough to be cut.
   *
   * What turning it always-on costs: this much text in the system prompt of
   * every run it applies to. Carried so the pane can say so before the switch
   * is thrown rather than after the bill arrives.
   */
  readonly bodyChars: number;
}

/**
 * The plugin name bridged skills are delivered under, and therefore the prefix
 * of the command a Claude session knows them by. Its one home: core's content
 * bridge delivers skills under it, and the renderer — which cannot import core
 * — draws the command with it, so the two cannot drift apart.
 */
export const BRIDGED_SKILL_PLUGIN = 'artemis-skills';

/** What to type for a skill in a Claude session: `/artemis-skills:unslop`. */
export function skillSlashCommand(name: string): string {
  return `/${BRIDGED_SKILL_PLUGIN}:${name}`;
}

/* -------------------------------------------------------------------------- */
/* Always on                                                                  */
/* -------------------------------------------------------------------------- */

/** One skill the user wants applied to every run it can reach. */
export interface AlwaysOnSkill {
  /** {@link SkillInfo.name}. Resolved on the machine the run executes on. */
  readonly name: string;
  /** Which accounts it applies to. Same meaning as a standing prompt's scope. */
  readonly scope: AgentPromptScope;
}

/**
 * The stored choices, whole. Versioned for the reason the prompt library is.
 *
 * Order is the order the skills are composed in, and it is the order they were
 * switched on. A name appears at most once.
 *
 * A name with no skill behind it is *kept*, not swept: the folder may be on its
 * way back (a source mid-pull, a drive not mounted, a skill that exists on the
 * server and not here), and a choice that evaporated the first time its skill
 * was briefly absent would have to be made again by someone who never unmade
 * it. It simply composes to nothing until the skill is there.
 */
export interface SkillLibraryDocument {
  readonly version: 1;
  readonly alwaysOn: readonly AlwaysOnSkill[];
  /**
   * The repositories Artemis keeps cloned on this machine. See {@link SkillSource}.
   *
   * Absent rather than empty when there are none, so a library written before
   * sources existed is byte-identical to one written after by a user who has
   * none. In the same document as the choices above because they are one
   * setting from a person's side — "my skills" — but never written by the same
   * path: a save from the pane replaces `alwaysOn` and cannot touch this list,
   * which only main edits, because an entry here is a URL main will clone.
   */
  readonly sources?: readonly SkillSource[];
}

export const SKILL_LIBRARY_VERSION = 1;

/** Bounds, mirrored by the IPC validator. */
export const SKILL_LIMITS = {
  /** A folder name. Generous; a guard against a corrupt file, not a design limit. */
  name: 200,
  /** Always-on entries in one library. */
  count: 200,
  /**
   * The most of one skill's body that is ever injected.
   *
   * The same ceiling a standing prompt has, for the same reason: far past any
   * reasonable instruction, and low enough that one enormous `SKILL.md` cannot
   * quietly consume a context window on every run. A body past it is cut and
   * says so, rather than being dropped — most of a skill is better than none.
   */
  body: 60_000,
  /** A remote URL. Long enough for any forge; short enough to be a URL. */
  url: 2_000,
  /** The folder inside a repository that holds its skills. */
  subdir: 200,
  /** Sources on one machine. A guard against a corrupt file, not a design limit. */
  sources: 20,
} as const;

export function defaultSkillLibraryDocument(): SkillLibraryDocument {
  return { version: SKILL_LIBRARY_VERSION, alwaysOn: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseScope(value: unknown): AgentPromptScope {
  if (isRecord(value) && value['kind'] === 'profiles' && Array.isArray(value['profileIds'])) {
    const profileIds = value['profileIds'].filter(
      (id): id is string => typeof id === 'string' && id.length > 0,
    );
    return { kind: 'profiles', profileIds: [...new Set(profileIds)] as ProfileId[] };
  }
  // Anything unreadable is the default, and the default is `all`: a choice the
  // user made must not shrink to "nobody" because a file was hand-edited badly.
  return { kind: 'all' };
}

/**
 * Rebuild a library from untrusted input — a file on disk, an IPC payload.
 *
 * Constructs fresh objects holding only the fields the contract names, drops
 * entries it cannot make sense of, and keeps the first of two entries naming
 * the same skill. An unreadable document is the defaults, never an error: this
 * is read on the path of every run.
 *
 * A name is kept **exactly as it was given**, never trimmed. It is a folder's
 * name, which is an identity rather than prose: a folder can legally be called
 * `" notes"`, the list reports it that way, and everything downstream — the
 * switch on its row, the lookup when a run composes it — matches by equality.
 * Tidying the stored copy would make the choice name a different skill from the
 * one that was switched on: the real row would read "off" and a second row for
 * the tidied name would appear under "not on this machine". Only a name with
 * nothing in it at all is refused.
 */
export function parseSkillLibraryDocument(value: unknown): SkillLibraryDocument {
  if (!isRecord(value)) return defaultSkillLibraryDocument();

  // The two halves are read independently: a hand-edit that broke one must not
  // cost the other, and a machine's sources are the more expensive to lose.
  const sources = parseSkillSources(value['sources']);
  const alwaysOn: AlwaysOnSkill[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(value['alwaysOn']) ? value['alwaysOn'] : []) {
    if (!isRecord(raw)) continue;
    const name = typeof raw['name'] === 'string' ? raw['name'] : '';
    if (name.trim().length === 0 || name.length > SKILL_LIMITS.name || seen.has(name)) continue;
    seen.add(name);
    alwaysOn.push({ name, scope: parseScope(raw['scope']) });
    if (alwaysOn.length >= SKILL_LIMITS.count) break;
  }
  return {
    version: SKILL_LIBRARY_VERSION,
    alwaysOn,
    ...(sources.length === 0 ? {} : { sources }),
  };
}

function parseSkillSources(value: unknown): readonly SkillSource[] {
  if (!Array.isArray(value)) return [];
  const sources: SkillSource[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw['url'] !== 'string') continue;
    const url = raw['url'].trim();
    const subdir = typeof raw['subdir'] === 'string' ? raw['subdir'].trim() : DEFAULT_SKILL_SOURCE_SUBDIR;
    if (skillSourceUrlProblem(url) !== null || skillSourceSubdirProblem(subdir) !== null) continue;
    // The id is derived, never trusted: it names a folder main will create and
    // delete, and a stored one could be edited to name somebody else's.
    const id = skillSourceIdFor(url);
    if (seen.has(id)) continue;
    seen.add(id);
    sources.push({ id, url, subdir });
    if (sources.length >= SKILL_LIMITS.sources) break;
  }
  return sources;
}

/** Is this skill switched on for anyone? */
export function isAlwaysOn(document: SkillLibraryDocument, name: string): boolean {
  return document.alwaysOn.some((entry) => entry.name === name);
}

/**
 * The library with one skill switched on or off.
 *
 * Switching on appends, so a newly chosen skill composes after the ones already
 * there; switching off removes the entry and its scope with it. Switching on a
 * skill that is already on changes nothing — in particular it does not reset a
 * scope the user narrowed.
 */
export function withSkillAlwaysOn(
  document: SkillLibraryDocument,
  name: string,
  on: boolean,
): SkillLibraryDocument {
  const present = isAlwaysOn(document, name);
  if (on === present) return document;
  return {
    ...document,
    alwaysOn: on
      ? [...document.alwaysOn, { name, scope: { kind: 'all' } }]
      : document.alwaysOn.filter((entry) => entry.name !== name),
  };
}

/** The names that apply to one account, in composition order. */
export function alwaysOnSkillNames(
  document: SkillLibraryDocument,
  profileId: ProfileId,
): readonly string[] {
  return document.alwaysOn
    .filter((entry) => scopeCovers(entry.scope, profileId))
    .map((entry) => entry.name);
}

/**
 * Are always-on skills composed into a run of this provider *on this machine*?
 *
 * Two conditions, and the second is the one worth a named function. The first
 * is the one standing instructions have: a provider that cannot take an append
 * is not sent one, because the pane would then be claiming something the model
 * never read.
 *
 * The second is where the run executes. A run on an Artemis server happens on
 * that machine, and an always-on skill names the folder its files are in —
 * composed here it would hand an agent working on one disk the paths of
 * another. Such a run is to carry the skills' *names* for the server to compose
 * from its own copy, the memory banks' arrangement for the same reason; until
 * that is built, it is given none.
 *
 * Here rather than in the engine because the pane asks it too: a skill that
 * only accounts this answers `false` for can reach is priced at nothing.
 */
export function composesAlwaysOnSkillsHere(providerId: string, systemPromptAppend: boolean): boolean {
  return systemPromptAppend && providerId !== 'artemis';
}

/* -------------------------------------------------------------------------- */
/* Composition                                                                */
/* -------------------------------------------------------------------------- */

/** One skill, read off the disk of the machine the run executes on. */
export interface ResolvedSkill {
  readonly name: string;
  /** The folder the body's relative references resolve against. */
  readonly dir: string;
  /** `SKILL.md` without its frontmatter. */
  readonly body: string;
}

/**
 * The text that makes skills always-on, or `undefined` when there is none.
 *
 * `undefined` rather than an empty string for the reason `composeAgentPrompts`
 * gives: an absent system prompt lets the provider's own preset through
 * untouched, and an append carrying nothing still costs a cache invalidation.
 *
 * Each skill goes under a heading that names it, with one sentence that is the
 * whole difference between this and the skill being merely *available*: follow
 * it without being asked. The folder is named because a skill's body refers to
 * files beside it, and a relative path means nothing to a model that was never
 * told where it is relative to.
 *
 * A skill with an empty body composes to nothing rather than to a heading over
 * nothing — an instruction to follow no instructions is noise in every run.
 */
export function composeAlwaysOnSkills(skills: readonly ResolvedSkill[]): string | undefined {
  const parts: string[] = [];
  for (const skill of skills) {
    const trimmed = skill.body.trim();
    if (trimmed.length === 0) continue;
    const body =
      trimmed.length > SKILL_LIMITS.body
        ? `${trimmed.slice(0, SKILL_LIMITS.body)}\n\n[The rest of this skill was cut for length. Read \`${skill.dir}/SKILL.md\` for all of it.]`
        : trimmed;
    parts.push(
      [
        `# Always-on skill: ${skill.name}`,
        '',
        `Follow this skill for the whole session, without being asked, wherever it applies. Files it mentions are relative to \`${skill.dir}\`.`,
        '',
        body,
      ].join('\n'),
    );
  }
  return parts.length === 0 ? undefined : parts.join('\n\n');
}

/* -------------------------------------------------------------------------- */
/* Sources                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A repository of skills Artemis keeps cloned and pulled on this machine.
 *
 * The point is that the list of skills a person wants is one thing, kept in one
 * place, and every machine they work on should simply have it — without an
 * installer run by hand on each one and a scheduled task to keep it fresh. The
 * repository is the source of truth; a machine's copy is a cache of it, which
 * is why the copy is reset to the remote on every sync rather than merged.
 *
 * The clone lives under Artemis's own data directory, never in the user's home:
 * identical on every platform, any number of sources, and nothing of the user's
 * is moved aside to make room.
 */
export interface SkillSource {
  /**
   * Derived from {@link url} by {@link skillSourceIdFor}, and the name of the
   * folder the clone lives in. Derived rather than minted so the same
   * repository is the same source on every machine, and rather than stored so
   * a hand-edited file cannot point the folder main creates — and deletes —
   * somewhere else.
   */
  readonly id: string;
  /** The remote, as given. `https://…`, `ssh://…` or `git@host:path`. */
  readonly url: string;
  /**
   * The folder inside the repository that holds the skills, one per
   * sub-folder. `skills` unless the repository is laid out differently.
   */
  readonly subdir: string;
}

export const DEFAULT_SKILL_SOURCE_SUBDIR = 'skills';

/**
 * Why a URL cannot be a source, or `null` when it can.
 *
 * One rule for the pane's disabled Add button and the IPC validator, so the two
 * cannot drift. Three shapes are accepted, which are the three a forge hands
 * out. What is refused, and why:
 *
 *  - **Anything else**, including `file:` and a bare path: this string is handed
 *    to `git clone` by the main process on the say-so of a renderer, and git's
 *    `ext::` transport runs a command. An allowlist of transports is the only
 *    rule that does not need updating when git grows another one.
 *  - **A leading hyphen**, which git would read as an option.
 *  - **A credential in the URL.** `https://user:token@host/…` works, which is
 *    the problem: it would put a secret in a settings file in plain text, and
 *    in every log line that names the source. The machine's own git credentials
 *    are what a private repository is reached with.
 */
const CREDENTIAL_IN_URL =
  'Leave the username and token out of the URL. A private repository is reached with this machine’s own git credentials.';

export function skillSourceUrlProblem(url: string): string | null {
  const trimmed = url.trim();
  if (trimmed.length === 0) return 'Enter the repository’s URL.';
  if (trimmed.length > SKILL_LIMITS.url) return 'That URL is too long to be one.';
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f]/.test(trimmed)) return 'A URL cannot contain spaces or control characters.';
  if (trimmed.startsWith('-')) return 'A URL cannot start with a hyphen.';

  if (/^https:\/\//i.test(trimmed)) {
    if (/^https:\/\/[^/]*@/i.test(trimmed)) return CREDENTIAL_IN_URL;
    return /^https:\/\/[^/]+\/.+/i.test(trimmed) ? null : 'That URL names a host but no repository.';
  }
  if (/^ssh:\/\/[^/]+\/.+/i.test(trimmed)) {
    // A bare user is how ssh is addressed (`ssh://git@host/…`) and stays
    // legal; a `user:password@` is a credential, and this is the one transport
    // besides https that has somewhere to put one.
    return /^ssh:\/\/[^/@]*:[^/@]*@/i.test(trimmed) ? CREDENTIAL_IN_URL : null;
  }
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[^:].*$/.test(trimmed)) return null;
  return 'Use an https://, ssh:// or git@host:owner/repo URL.';
}

/** Why a folder cannot be a source's skills folder, or `null` when it can. */
export function skillSourceSubdirProblem(subdir: string): string | null {
  const trimmed = subdir.trim();
  if (trimmed.length === 0) return 'Name the folder that holds the skills.';
  if (trimmed.length > SKILL_LIMITS.subdir) return 'That folder name is too long.';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(trimmed)) return 'A folder name cannot contain control characters.';
  if (trimmed.startsWith('/') || trimmed.startsWith('\\') || /^[A-Za-z]:/.test(trimmed)) {
    return 'The folder is relative to the repository, not to the disk.';
  }
  if (trimmed.split(/[\\/]/).some((segment) => segment === '..' || segment === '')) {
    return 'The folder has to be inside the repository.';
  }
  return null;
}

/**
 * The folder name a source's clone lives under, from its URL.
 *
 * Readable first — `github.com-david-systemtech-agent-skills` tells a person
 * looking in the data directory what they are looking at — and unique second:
 * two URLs that flatten to the same words (`a/b-c` and `a-b/c`) are told apart
 * by the hash of the URL itself. The scheme, any user name and a trailing
 * `.git` are dropped first, so the https and ssh spellings of one repository
 * are one source rather than two clones of it.
 *
 * FNV-1a rather than a real digest because this package may not import one —
 * it is loaded in a renderer — and nothing here is a security boundary: the
 * worst a collision does is make two repositories share a folder name, and
 * they would have to collide on the readable half as well.
 */
export function skillSourceIdFor(url: string): string {
  const canonical = url
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^[^@/]+@/, '')
    .replace(/:/, '/')
    .replace(/\.git\/?$/, '')
    .replace(/\/+$/, '');

  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // Cut, *then* trimmed: a cut that lands on a hyphen would otherwise leave
  // one on the end, the id would read `…--1a2b3c4d`, and the validators that
  // guard removing and pulling a source — which hold an id to exactly the
  // alphabet written here — would refuse it for as long as it existed.
  const words = canonical.replace(/[^a-z0-9]+/g, '-').slice(0, 80).replace(/^-+|-+$/g, '');
  return `${words.length === 0 ? 'source' : words}-${hash.toString(16).padStart(8, '0')}`;
}

/**
 * What to call a source in a sentence: `david-systemtech/agent-skills`.
 *
 * The last two path segments, which is how a forge names a repository and how a
 * person says it. The host is left out because it is nearly always the same one
 * and the row has the full URL beside it for when it is not.
 */
export function skillSourceLabel(url: string): string {
  const path = url
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/^[^@/]+@/, '')
    .replace(/^[^/:]+[/:]/, '')
    .replace(/\.git\/?$/i, '')
    .replace(/\/+$/, '');
  const segments = path.split('/').filter((segment) => segment.length > 0);
  return segments.length === 0 ? url.trim() : segments.slice(-2).join('/');
}

/** The library with a source added. The same repository twice is one source. */
/**
 * Why one more source cannot be added, or `null` when it can.
 *
 * {@link SKILL_LIMITS.sources} is a bound on a file, and the parser applies it
 * by keeping the first twenty — right for a corrupt document, and exactly
 * wrong for the one moment a person can run into it: the source they just
 * added would be the one dropped, without a word. So the hosts ask first.
 * Re-adding a URL already held replaces it, which is never over the limit.
 */
export function skillSourceLimitProblem(document: SkillLibraryDocument, url: string): string | null {
  const sources = document.sources ?? [];
  if (sources.length < SKILL_LIMITS.sources) return null;
  if (sources.some((source) => source.id === skillSourceIdFor(url))) return null;
  return `Artemis keeps at most ${String(SKILL_LIMITS.sources)} skill repositories. Remove one before adding another.`;
}

export function withSkillSource(
  document: SkillLibraryDocument,
  url: string,
  subdir: string = DEFAULT_SKILL_SOURCE_SUBDIR,
): SkillLibraryDocument {
  const source: SkillSource = { id: skillSourceIdFor(url), url: url.trim(), subdir: subdir.trim() };
  const others = (document.sources ?? []).filter((entry) => entry.id !== source.id);
  return { ...document, sources: [...others, source] };
}

/** The library without a source. The always-on choices are left alone. */
export function withoutSkillSource(document: SkillLibraryDocument, id: string): SkillLibraryDocument {
  const remaining = (document.sources ?? []).filter((entry) => entry.id !== id);
  const { sources: _dropped, ...rest } = document;
  return remaining.length === 0 ? rest : { ...rest, sources: remaining };
}

/** One source, and how its copy on this machine is doing. */
export interface SkillSourceStatus {
  readonly source: SkillSource;
  /** The clone exists. False between adding a source and its first sync landing. */
  readonly cloned: boolean;
  /** The commit the copy is at, abbreviated. */
  readonly head?: string;
  /** When it last synced successfully, in epoch milliseconds. */
  readonly syncedAt?: number;
  /**
   * Why the last sync failed, in git's own last line. Absent when it did not.
   * A source that fails to sync keeps serving the copy it has.
   */
  readonly error?: string;
  /** How many skills its folder holds right now. */
  readonly skillCount: number;
}
