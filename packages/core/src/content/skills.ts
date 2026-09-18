/**
 * Reading the skills on this machine: what each one is, and what it says.
 * ============================================================================
 *
 * `bridge.ts` delivers skills to a run and needs only their folders. Two newer
 * questions need more than a folder:
 *
 *  - the settings pane lists what a session would be offered, so it needs each
 *    skill's **description** and the two frontmatter switches that decide how
 *    it can be invoked;
 *  - an always-on skill is appended to a run's system prompt, so something has
 *    to read its **body** on the machine the run executes on.
 *
 * Both are answered here, over exactly the folders the bridge reads, found by
 * the bridge's own test of what counts as a skill ({@link skillFoldersIn}). The
 * list and the run cannot then disagree about what exists.
 *
 * Nothing here throws. A skill whose `SKILL.md` cannot be read is listed with
 * an empty description and resolves to no body: a pane that failed to open, or
 * a run that failed to start, over one unreadable file would be the wrong trade
 * in both directions.
 */

import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type {
  ProfileId,
  ResolvedSkill,
  SkillInfo,
  SkillOrigin,
  SkillPluginOffer,
} from '@rx-artemis/protocol';
import { SKILL_LIMITS, skillSlashCommand } from '@rx-artemis/protocol';

import { parseFrontmatter } from '../memorybanks/frontmatter.js';
import { marketplaceSkillOffers, neutralSkillsDir, offeredNameOf, skillFoldersIn } from './bridge.js';
import type { SkillSourceRoot } from './skillSources.js';

/** One account that can be offered skills: a Claude or Codex profile. */
export interface SkillAccount {
  readonly profileId: ProfileId;
  /** The profile's config directory; its `skills/` is the account's own folder. */
  readonly configDir: string;
}

/** A folder of skills, and what to call where it came from. */
export interface SkillRoot {
  readonly dir: string;
  readonly origin: SkillOrigin;
}

/* -------------------------------------------------------------------------- */
/* One skill                                                                  */
/* -------------------------------------------------------------------------- */

/** What a `SKILL.md` says, reduced to what Artemis reads. */
export interface SkillDocument {
  /**
   * The name a session knows the skill by: its frontmatter `name`, or `null`
   * when it gives none and the folder's name stands in. See `offeredNameOf`.
   */
  readonly declaredName: string | null;
  readonly description: string;
  readonly modelInvocable: boolean;
  readonly userInvocable: boolean;
  /** Everything after the frontmatter. */
  readonly body: string;
}

const UNREADABLE: SkillDocument = {
  declaredName: null,
  description: '',
  modelInvocable: true,
  userInvocable: true,
  body: '',
};

/**
 * A frontmatter switch, read the way the provider reads it.
 *
 * YAML 1.2 only calls `true` and `false` booleans, so `yes`, `on` and `1`
 * arrive as a string or a number — and the provider's own documentation accepts
 * all of them. Anything else, including an absent key, is `fallback`.
 */
function flag(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (['true', 'yes', 'on', '1'].includes(lowered)) return true;
    if (['false', 'no', 'off', '0'].includes(lowered)) return false;
  }
  return fallback;
}

/** Read one skill's `SKILL.md`. Unreadable is the defaults, never an error. */
export async function readSkillDocument(dir: string): Promise<SkillDocument> {
  const raw = await readFile(join(dir, 'SKILL.md'), 'utf8').catch(() => null);
  if (raw === null) return UNREADABLE;

  const { data, body } = parseFrontmatter(raw);
  // Real YAML, so a folded `description: >-` block arrives as the one line it
  // means — most published skills write it that way, and a line-by-line reader
  // shows them as ">-".
  const description = typeof data?.['description'] === 'string' ? data['description'] : '';
  const declaredName = data?.['name'];
  return {
    declaredName:
      typeof declaredName === 'string' && declaredName.trim().length > 0 ? declaredName.trim() : null,
    description: description.replace(/\s+/g, ' ').trim(),
    // The key disables, so it reads inverted: absent means the model may.
    modelInvocable: !flag(data?.['disable-model-invocation'], false),
    userInvocable: flag(data?.['user-invocable'], true),
    body,
  };
}

/* -------------------------------------------------------------------------- */
/* The folders                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The folders one account is offered skills from, in winning order.
 *
 * The order `buildContentBridge` merges in — the account's own folder, then the
 * machine-wide one, then the synced sources — so resolving a name here finds
 * the same skill a run on that account would be given.
 */
export function skillRootsFor(
  account: SkillAccount,
  home: string = homedir(),
  sources: readonly SkillSourceRoot[] = [],
): readonly SkillRoot[] {
  return [
    { dir: join(account.configDir, 'skills'), origin: { kind: 'profile', profileIds: [account.profileId] } },
    { dir: neutralSkillsDir(home), origin: { kind: 'machine' } },
    ...sourceRoots(sources),
  ];
}

function sourceRoots(sources: readonly SkillSourceRoot[]): readonly SkillRoot[] {
  return sources.map(({ id, dir }): SkillRoot => ({ dir, origin: { kind: 'source', sourceId: id } }));
}

export interface ListSkillsOptions {
  /** Every local account that can be offered skills. */
  readonly accounts: readonly SkillAccount[];
  /** Defaults to the real home directory. Injected for tests. */
  readonly home?: string;
  /** The synced sources' skills folders, in the order they were added. */
  readonly sources?: readonly SkillSourceRoot[];
}

/**
 * Every skill a session on this machine could be offered, one row per name.
 *
 * ## Accounts that share a folder are one folder
 *
 * Under the shared-`~/.claude` arrangement every Claude profile's `skills` is a
 * link to the same directory. Read naively that is the same skills once per
 * account, and whichever account happened to be first would be named as the
 * only one that has them. So account folders are grouped by where they *really*
 * are, read once, and the row names every account that reaches it.
 *
 * ## One row per name, and the winner is the one a run would get
 *
 * Account folders before the machine-wide one, and synced sources last,
 * matching the bridge's precedence: a skill a person put on the machine by
 * hand wins the name over the copy that arrived by subscription. A name that exists in both is listed once, as the account's copy,
 * because that is the copy that account's sessions are given. The machine copy
 * still reaches every *other* account — a nuance one row cannot carry, and the
 * uncommon case: the point of the machine folder is to not keep per-account
 * copies.
 *
 * Two accounts with *separate* copies of one name are one row as well, and it
 * names both: each is offered a skill by that name, and the switch on the row
 * reaches both. What the row says the skill is for, and what it costs, are the
 * first account's copy's — the other nuance one row cannot carry.
 *
 * ## A name a marketplace plugin offers
 *
 * A Claude run is given an enabled marketplace plugin whole, and
 * `resolveContentPlugins` leaves a same-named skill out of the bridge so the
 * session is not offered it twice. The row still lists the person's copy — it
 * is theirs, and always-on still reads it — and says which accounts get the
 * name from a plugin instead, and what it is typed as there. Read through the
 * function the run itself uses, so the pane cannot describe a different split.
 */
export async function listSkills(options: ListSkillsOptions): Promise<readonly SkillInfo[]> {
  const home = options.home ?? homedir();

  // Group the accounts' own folders by their real location.
  const byRealDir = new Map<string, { dir: string; profileIds: ProfileId[] }>();
  for (const account of options.accounts) {
    const dir = join(account.configDir, 'skills');
    const real = await realpath(dir).catch(() => null);
    // A folder that does not exist holds no skills; nothing to group.
    if (real === null) continue;
    const group = byRealDir.get(real);
    if (group) group.profileIds.push(account.profileId);
    else byRealDir.set(real, { dir, profileIds: [account.profileId] });
  }

  const roots: SkillRoot[] = [
    ...[...byRealDir.values()].map(
      ({ dir, profileIds }): SkillRoot => ({ dir, origin: { kind: 'profile', profileIds } }),
    ),
    { dir: neutralSkillsDir(home), origin: { kind: 'machine' } },
    ...sourceRoots(options.sources ?? []),
  ];

  // What each account's enabled plugins offer. Nothing for a Codex account,
  // whose config directory has no install record to read.
  const offersByAccount = await Promise.all(
    options.accounts.map(async (account) => ({
      profileId: account.profileId,
      offers: await marketplaceSkillOffers({ configDir: account.configDir, home }),
    })),
  );
  const pluginOffersFor = (offeredName: string, origin: SkillOrigin): readonly SkillPluginOffer[] => {
    const byPlugin = new Map<string, ProfileId[]>();
    for (const { profileId, offers } of offersByAccount) {
      // An account the skill does not reach has nothing to be displaced from.
      if (origin.kind === 'profile' && !origin.profileIds.includes(profileId)) continue;
      const plugin = offers.get(offeredName);
      if (plugin === undefined) continue;
      byPlugin.set(plugin, [...(byPlugin.get(plugin) ?? []), profileId]);
    }
    return [...byPlugin].map(([plugin, profileIds]) => ({
      plugin,
      command: skillSlashCommand(offeredName, plugin),
      profileIds,
    }));
  };

  const byName = new Map<string, SkillInfo & { readonly offeredName: string }>();
  for (const root of roots) {
    for (const folder of await skillFoldersIn(root.dir)) {
      const listed = byName.get(folder.name);
      if (listed !== undefined) {
        if (listed.origin.kind === 'profile' && root.origin.kind === 'profile') {
          byName.set(folder.name, {
            ...listed,
            origin: { kind: 'profile', profileIds: [...listed.origin.profileIds, ...root.origin.profileIds] },
          });
        }
        continue;
      }
      const document = await readSkillDocument(folder.dir);
      byName.set(folder.name, {
        name: folder.name,
        description: document.description,
        origin: root.origin,
        dir: folder.dir,
        modelInvocable: document.modelInvocable,
        userInvocable: document.userInvocable,
        // What a run is given, not what the file holds: composition cuts a
        // body at the limit, and a price past it is for text no run receives.
        bodyChars: Math.min(document.body.trim().length, SKILL_LIMITS.body),
        offeredName: offeredNameOf(document.declaredName, folder.name),
      });
    }
  }

  // Plugin offers last, once every row's origin names all the accounts it
  // reaches: a second account's folder can still widen a row above.
  const rows = [...byName.values()].map(({ offeredName, ...row }): SkillInfo => {
    const pluginOffers = pluginOffersFor(offeredName, row.origin);
    return pluginOffers.length === 0 ? row : { ...row, pluginOffers };
  });

  // By name, so the list holds still between reads: `readdir` order is the
  // filesystem's business and differs between a laptop and a server.
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

/* -------------------------------------------------------------------------- */
/* Resolving names, for a run                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Turn skill names into the text a run is given, on this machine.
 *
 * The first root holding a name wins, so pass {@link skillRootsFor} for the
 * run's own account. A name no root holds is skipped silently — see
 * `SkillLibraryDocument` on why the stored choice outlives a briefly absent
 * skill — and so is one whose body is empty.
 *
 * The answer is in the order the names were given, which is the order the user
 * switched them on.
 */
export async function resolveSkills(
  names: readonly string[],
  roots: readonly SkillRoot[],
): Promise<readonly ResolvedSkill[]> {
  if (names.length === 0) return [];

  const folders = new Map<string, string>();
  for (const root of roots) {
    for (const folder of await skillFoldersIn(root.dir)) {
      if (!folders.has(folder.name)) folders.set(folder.name, folder.dir);
    }
  }

  const resolved: ResolvedSkill[] = [];
  for (const name of names) {
    const dir = folders.get(name);
    if (dir === undefined) continue;
    const { body } = await readSkillDocument(dir);
    if (body.trim().length === 0) continue;
    resolved.push({ name, dir, body });
  }
  return resolved;
}
