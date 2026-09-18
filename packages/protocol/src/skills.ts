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
 * served request carries names rather than prose. The memory banks' prompt
 * already works this way, for the same reason: text naming one machine's paths
 * is wrong on every other machine.
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
 */
export function parseSkillLibraryDocument(value: unknown): SkillLibraryDocument {
  if (!isRecord(value) || !Array.isArray(value['alwaysOn'])) return defaultSkillLibraryDocument();

  const alwaysOn: AlwaysOnSkill[] = [];
  const seen = new Set<string>();
  for (const raw of value['alwaysOn']) {
    if (!isRecord(raw)) continue;
    const name = typeof raw['name'] === 'string' ? raw['name'].trim() : '';
    if (name.length === 0 || name.length > SKILL_LIMITS.name || seen.has(name)) continue;
    seen.add(name);
    alwaysOn.push({ name, scope: parseScope(raw['scope']) });
    if (alwaysOn.length >= SKILL_LIMITS.count) break;
  }
  return { version: SKILL_LIBRARY_VERSION, alwaysOn };
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
    version: document.version,
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
 * repository is the source of truth; a machine's copy is a cache of it.
 *
 * The clone lives under Artemis's own data directory, never in the user's home:
 * identical on every platform, any number of sources, and nothing of the user's
 * is moved aside to make room.
 */
export interface SkillSource {
  /** Stable for the source's life; what {@link SkillOrigin} points at. */
  readonly id: string;
  /** The remote, as given. `https://…` or `git@…`. */
  readonly url: string;
  /**
   * The folder inside the repository that holds the skills, one per
   * sub-folder. `skills` unless the repository is laid out differently.
   */
  readonly subdir: string;
}
