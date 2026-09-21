/**
 * Matching what the user typed against the slash commands a run exposes.
 * ============================================================================
 *
 * Pure, and separate from the composer, because the interesting part is the
 * ranking and the ranking is the part worth asserting. `Composer.tsx` owns the
 * keyboard and the markup; this owns the question "given this draft and where
 * the caret is, what should be on offer, and in what order".
 *
 * ---------------------------------------------------------------------------
 * WHY RANKING IS NEEDED AT ALL
 * ---------------------------------------------------------------------------
 *
 * Because bridged names are prefixed. A command the user installed as
 * `commands/cerebro.md` reaches the session as `artemis-skills:cerebro` — the
 * plugin channel renames it, and the bare form is refused outright. Nobody is
 * going to type `artemis-skills:`, so `cer` has to find it, which means matching
 * inside the name and not just at its head.
 *
 * That alone would rank badly: a plain substring match puts
 * `artemis-skills:cerebro` level with any built-in that merely contains the same
 * letters. So the segment after the colon is matched as a name in its own right
 * and ranked above a loose hit — see {@link SLASH_RANKS}. The user types the name
 * they know and the thing they meant is first.
 *
 * ---------------------------------------------------------------------------
 * WHEN THE MENU IS OPEN
 * ---------------------------------------------------------------------------
 *
 * While the caret is inside a slash token — `/`, `/cer`, `/artemis-skills:c` —
 * wherever that token sits in the draft. The first space still closes it,
 * because past the name the user is typing arguments and a menu over their
 * sentence is in the way; what changed is that the token no longer has to be
 * the whole draft. `sort the imports and /uns` opens it too, and
 * `hoistSlashCommand` is what makes the command the user then picks actually
 * run — the provider only honours one at the front of the message, so the
 * draft is rearranged on its way out.
 *
 * ---------------------------------------------------------------------------
 * WHY A MID-DRAFT TOKEN IS TREATED MORE CAUTIOUSLY
 * ---------------------------------------------------------------------------
 *
 * A leading slash is unambiguous: nothing else starts a message that way. A
 * slash in the middle of a sentence is usually a path — `/etc/hosts`,
 * `/work/SYSTEM-SERVER`, `3/4`. Two things follow.
 *
 * A loose {@link SLASH_RANKS.contains} hit is not offered for a mid-draft
 * token, because `/w` would otherwise pop a menu over every command with a `w`
 * in it while somebody was three characters into typing a directory.
 *
 * And Enter keeps meaning *send* for a mid-draft token — see
 * {@link SlashMenu.enterAccepts}. Enter accepting a highlighted row is right
 * when the whole message is the command being typed; it is a hijack when the
 * message is a paragraph of prose that happens to contain a path. Tab accepts
 * everywhere, and a command typed out in full is lifted on send whether or not
 * the menu was ever used.
 */

import { canonicalCommandName, slashTokenAt, type SlashToken } from '@rx-artemis/protocol';

/**
 * How well a command matched, lowest first.
 *
 * Exported so the tests name the ranks rather than asserting on the integers,
 * and so the ordering is legible as a policy rather than as magic numbers.
 */
export const SLASH_RANKS = {
  /** The full name starts with what was typed — `/artemis` → `artemis-skills:…`. */
  fullPrefix: 0,
  /** The name after the last colon starts with it — `/cer` → `artemis-skills:cerebro`. */
  segmentPrefix: 1,
  /** It appears somewhere in the name — the loose fallback. */
  contains: 2,
} as const;

/** One command on offer, with what to insert and why it matched. */
export interface SlashMatch {
  /** The canonical name, exactly as the provider listed it. */
  readonly name: string;
  /**
   * The part a person actually recognises: the name after the last colon.
   *
   * Carried so the menu can show it prominently with the prefix as context,
   * rather than making the reader parse a colon-separated string.
   */
  readonly label: string;
  /** The plugin prefix, when there is one. Absent for a built-in. */
  readonly prefix?: string;
  readonly rank: number;
}

export interface SlashMenu {
  /** What was typed after the slash, verbatim. Empty when the token is just `/`. */
  readonly query: string;
  /** Where the token sits, so accepting one can write over it and leave the rest. */
  readonly token: SlashToken;
  /**
   * Whether Enter should accept the highlighted row rather than send.
   *
   * True only for a token that leads the draft. See the header.
   */
  readonly enterAccepts: boolean;
  /** Every match, best first. Never empty — {@link matchSlashCommands} returns null instead. */
  readonly matches: readonly SlashMatch[];
}

/** Split `plugin:name` into its parts, tolerating a name with no prefix. */
function split(name: string): { readonly label: string; readonly prefix?: string } {
  const at = name.lastIndexOf(':');
  if (at <= 0) return { label: name };
  return { label: name.slice(at + 1), prefix: name.slice(0, at) };
}

/**
 * What the menu should show for this draft, or `null` for "no menu".
 *
 * `null` rather than an empty list for all of the ways there is nothing to
 * show — the caret is not in a slash token, or nothing matched — because the
 * caller's question is only ever "is there a menu", and a query that matches
 * nothing should close the menu rather than show an empty box over the text.
 *
 * `caret` is the composer's selection start. It defaults to the end of the
 * draft so that a caller with no cursor to offer — a test, a headless check —
 * gets the behaviour of somebody who has just finished typing.
 */
export function matchSlashCommands(
  commands: readonly string[] | undefined,
  draft: string,
  caret: number = draft.length,
): SlashMenu | null {
  if (commands === undefined || commands.length === 0) return null;

  const token = slashTokenAt(draft, caret);
  if (token === null) return null;

  const needle = token.name.toLowerCase();

  const matches: SlashMatch[] = [];
  // Stripping the slash can collide two reported names onto one — `compact` and
  // `/compact` are the same command — and the menu keys its rows by name, so a
  // duplicate would be two identical rows sharing a React key.
  const seen = new Set<string>();
  for (const reported of commands) {
    const name = canonicalCommandName(reported);
    if (seen.has(name)) continue;
    seen.add(name);
    const { label, prefix } = split(name);
    const lower = name.toLowerCase();
    const rank =
      needle.length === 0 || lower.startsWith(needle)
        ? SLASH_RANKS.fullPrefix
        : label.toLowerCase().startsWith(needle)
          ? SLASH_RANKS.segmentPrefix
          : lower.includes(needle)
            ? SLASH_RANKS.contains
            : null;
    if (rank === null) continue;
    // The loose tier is for a token the user has committed to by starting the
    // message with it. Mid-sentence it is noise over a path. See the header.
    if (!token.leading && rank === SLASH_RANKS.contains) continue;
    matches.push({ name, label, rank, ...(prefix === undefined ? {} : { prefix }) });
  }

  if (matches.length === 0) return null;

  // Rank first, then alphabetically by the part the reader is scanning. Sorting
  // by the full name instead would file every bridged command under `a`, which
  // is the prefix's fault and not something the reader should have to know.
  matches.sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
  return { query: token.name, token, enterAccepts: token.leading, matches };
}

/**
 * Accepting a command is {@link writeSlashCommand} in the protocol, which the
 * TUI composer uses too: the same splice, the same caret rule, one place to fix
 * either. Re-exported here so this module stays the composer's one import for
 * everything about the menu.
 */
export { writeSlashCommand } from '@rx-artemis/protocol';
