/**
 * Slash commands, parsed.
 *
 * The composer's one piece of grammar. A message that begins with `/` and a
 * word the TUI knows is a command for the TUI; anything else — including a
 * `/command` the TUI does *not* know — is sent to the agent verbatim, because
 * providers have slash commands of their own (`/compact`, a project's custom
 * skills) and swallowing them here would make those unreachable.
 *
 * The other half of the grammar is finding a command before it has been typed
 * in full. `matchCommands` is the menu the composer draws: what was typed after
 * the `/` is matched against every name and alias the TUI owns and every
 * command the provider reported, from the start of a name or from a word inside
 * it, with the `:`, `_` and `-` separators optional on both sides. It is
 * deliberately not a fuzzy finder — a needle that is not a prefix of a run of
 * words is not a match at all — because the menu's whole value is that the top
 * row is safe to run blind: a typo matches nothing, nothing is highlighted, and
 * Enter sends the text to the agent instead of guessing which command was meant.
 *
 * Pure, so the tests can be exhaustive and the composer can be dumb.
 */

export type CommandName =
  | 'profile'
  | 'model'
  | 'mode'
  | 'resume'
  | 'attach'
  | 'copy'
  | 'export'
  | 'diff'
  | 'undo'
  | 'pin'
  | 'title'
  | 'asks'
  | 'timeline'
  | 'snip'
  | 'tasks'
  | 'usage'
  | 'handoff'
  | 'cwd'
  | 'new'
  | 'help'
  | 'quit';

export interface Command {
  readonly name: CommandName;
  /** Everything after the command word, trimmed. Empty when there was nothing. */
  readonly args: string;
}

export interface CommandSpec {
  readonly name: CommandName;
  readonly usage: string;
  readonly summary: string;
}

/** The menu, in the order `/help` prints it. */
export const COMMANDS: readonly CommandSpec[] = [
  { name: 'profile', usage: '/profile', summary: 'Switch the account the next conversation runs as' },
  { name: 'model', usage: '/model', summary: 'Choose the model, and its effort where it has one' },
  { name: 'mode', usage: '/mode', summary: 'Set the permission mode for the next turn' },
  { name: 'resume', usage: '/resume', summary: 'Pick up a stored conversation from this directory' },
  { name: 'attach', usage: '/attach <path>', summary: 'Send an image or file with the next message' },
  { name: 'copy', usage: '/copy', summary: 'Copy the last reply, or one of its code blocks, to the clipboard' },
  { name: 'export', usage: '/export [file]', summary: 'Write this conversation to a markdown file' },
  { name: 'diff', usage: '/diff', summary: "What this conversation changed, and the working tree's diff" },
  { name: 'undo', usage: '/undo', summary: 'Take back the last file change the agent made' },
  { name: 'pin', usage: '/pin', summary: 'Keep this conversation at the top of its folder' },
  { name: 'title', usage: '/title <name>', summary: 'Name this conversation' },
  { name: 'asks', usage: '/asks', summary: 'Every conversation waiting on a permission, answerable in one list' },
  { name: 'timeline', usage: '/timeline', summary: 'One line per turn: when, what, how long, what it cost, what it touched' },
  /*
   * The one command with subcommands, and the usage says so with a bracket
   * rather than by listing them: `/snip` alone is the list, which is how
   * somebody finds `save`, `rm` and `--examples` without the menu row having to
   * carry all three in a column two words wide.
   */
  { name: 'snip', usage: '/snip [name] [words]', summary: 'Expand a saved snippet, or list them; save, rm and --examples keep them' },
  { name: 'tasks', usage: '/tasks', summary: 'Background work: what is running, and what a delegated agent did' },
  { name: 'usage', usage: '/usage', summary: "The account's plan windows and how full they are" },
  { name: 'handoff', usage: '/handoff', summary: 'Move this conversation to another account, or start it fresh there' },
  { name: 'cwd', usage: '/cwd', summary: 'Choose where to work: a folder you have used, or browse for one' },
  { name: 'new', usage: '/new', summary: 'Start a fresh conversation on the same account' },
  { name: 'help', usage: '/help', summary: 'List these commands' },
  { name: 'quit', usage: '/quit', summary: 'Leave' },
];

const SPECS = new Map<string, CommandSpec>(COMMANDS.map((command) => [command.name, command]));

/** `/exit` and `/q` mean `/quit`; nobody should have to remember which. */
const ALIASES: Readonly<Record<string, CommandName>> = {
  exit: 'quit',
  q: 'quit',
  models: 'model',
  profiles: 'profile',
  account: 'profile',
  permissions: 'mode',
  permission: 'mode',
  clear: 'new',
  '?': 'help',
  sessions: 'resume',
  history: 'resume',
  continue: 'resume',
  task: 'tasks',
  bg: 'tasks',
  // Not `plan`: that is the provider's own command (Claude Code's plan mode),
  // and aliasing it here to a plan-*limits* readout swallowed it.
  limits: 'usage',
  file: 'attach',
  image: 'attach',
  // The words people reach for when they want the thing rather than the name
  // of the thing: what came out of the session, what went into the files, and
  // what this conversation is called.
  save: 'export',
  changes: 'diff',
  revert: 'undo',
  rename: 'title',
  name: 'title',
  // The three that landed with the ledger of turns, the card of asks, and the
  // snippets: the plural, the noun, and the word for what the list is.
  waiting: 'asks',
  turns: 'timeline',
  snippet: 'snip',
  snippets: 'snip',
  // The hand-off has a key of its own, and a key that half the terminals in
  // use cannot deliver needs a word as well. `move` is what somebody asks for
  // when they have not learned its name yet.
  move: 'handoff',
};

/**
 * Parse a composer submission.
 *
 * Returns the command when the text is one the TUI owns, `null` otherwise.
 * Leading whitespace is tolerated; a lone `/` is not a command; case does not
 * matter for the word but is preserved in the arguments.
 */
export function parseCommand(text: string): Command | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('/')) return null;
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (match === null) return null;
  const word = (match[1] ?? '').toLowerCase();
  const name = SPECS.has(word) ? (word as CommandName) : ALIASES[word];
  if (name === undefined) return null;
  return { name, args: (match[2] ?? '').trim() };
}

/** One row of the composer's menu. */
export interface CommandMatch {
  /** Identity for the row, unique across the TUI's commands and the provider's. */
  readonly key: string;
  /** The row as drawn: `/mode`, `/attach <path>`, `/artemis-skills:code-review`. */
  readonly usage: string;
  readonly summary: string;
  /**
   * Offsets in `usage` of the characters the needle matched, for bolding.
   * Empty when the row was found by an alias, because then the letters that
   * were typed are nowhere in the row to bold.
   */
  readonly indices: readonly number[];
  /** Which tier the row matched in; lower sorts first. */
  readonly rank: number;
}

/** Tiers, best first. A match by whole name beats an alias beats a word inside. */
const RANK_NAME = 0;
const RANK_ALIAS = 1;
const RANK_WORD = 2;

/**
 * What the provider's own commands are shifted by: the same three tiers, three
 * lower, so that every command the TUI owns outranks every command it does not.
 * The TUI's are the ones whose behaviour it can promise.
 */
const PROVIDER_TIER = 3;

/** Aliases grouped by what they mean, so one pass can try all of a row's. */
const ALIASES_BY_NAME = ((): ReadonlyMap<CommandName, readonly string[]> => {
  const grouped = new Map<CommandName, string[]>();
  for (const [alias, name] of Object.entries(ALIASES)) {
    const existing = grouped.get(name);
    if (existing === undefined) grouped.set(name, [alias]);
    else existing.push(alias);
  }
  return grouped;
})();

/**
 * What the composer offers for the text typed so far.
 *
 * `typed` is the composer's buffer, with or without its leading `/`; an empty
 * needle lists everything, which is what a lone `/` shows. Matching is
 * case-insensitive, and the separators `:`, `_` and `-` are optional on both
 * sides: `/codereview` finds `code-review` and `/code-rev` finds it too. A
 * needle matches from the start of a name — or of an alias — or from the start
 * of a word inside it, which is what makes `/review` reach the bridged
 * `artemis-skills:code-review` that nobody would look for under the
 * marketplace's name.
 *
 * Nothing else matches. Letters found scattered through a name are not a match,
 * because the point of the menu is that the highlighted row can be run without
 * reading it: `/mdoel` returns nothing, and the composer sends it to the agent.
 */
export function matchCommands(typed: string, providerCommands: readonly string[] = []): readonly CommandMatch[] {
  const needle = withoutSeparators(typed.replace(/^\//, '').toLowerCase());
  const matches: CommandMatch[] = [];

  for (const spec of COMMANDS) {
    const hit = matchName(needle, spec.name);
    const ranks: number[] = [];
    if (hit !== null) ranks.push(hit.word === 0 ? RANK_NAME : RANK_WORD);
    const aliases = ALIASES_BY_NAME.get(spec.name) ?? [];
    if (aliases.some((alias) => matchName(needle, alias) !== null)) ranks.push(RANK_ALIAS);
    if (ranks.length === 0) continue;
    // One row per command however many ways it was found, at its best tier —
    // `/m` must not list `/model` twice for the name and for `models`.
    matches.push({
      key: spec.name,
      usage: spec.usage,
      summary: spec.summary,
      // `usage` carries the slash the name does not.
      indices: (hit?.indices ?? []).map((at) => at + 1),
      rank: Math.min(...ranks),
    });
  }

  for (const name of providerCommands) {
    const hit = matchName(needle, name);
    if (hit === null) continue;
    matches.push({
      key: `provider:${name}`,
      usage: `/${name}`,
      // The plugin's name is already the front half of the row; saying it again
      // in the description column is noise. What the column is for is the
      // distinction the name does not carry — whether this came from the user's
      // own skills or from the provider itself.
      summary: name.includes(':') ? 'skill' : 'provider command',
      indices: hit.indices.map((at) => at + 1),
      rank: PROVIDER_TIER + (hit.word === 0 ? RANK_NAME : RANK_WORD),
    });
  }

  // Sorted rather than bucketed, and stably, so that inside a tier the rows
  // stay in the order they are declared in: the menu someone learned the shape
  // of does not rearrange itself as they type another letter.
  return matches.sort((left, right) => left.rank - right.rank);
}

/**
 * Commands the TUI owns that match what has been typed so far. An empty prefix
 * lists everything.
 */
export function completeCommand(prefix: string): readonly CommandSpec[] {
  return matchCommands(prefix).flatMap((match) => {
    const spec = SPECS.get(match.key);
    return spec === undefined ? [] : [spec];
  });
}

/**
 * The provider's own commands that match what has been typed — matched on the
 * name a person would think of.
 *
 * A bridged skill arrives fully qualified: `artemis-skills:code-review`. Nobody
 * reaches for that by typing the marketplace's name first, and matching only
 * on the whole string means the rows a user is actually looking for are
 * unreachable unless they already know which plugin owns them. So a word inside
 * the name matches too, and a whole-name match sorts first because someone who
 * did type the prefix meant it.
 */
export function completeProviderCommand(prefix: string, commands: readonly string[]): readonly string[] {
  return matchCommands(prefix, commands)
    .filter((match) => match.rank >= PROVIDER_TIER)
    .map((match) => match.usage.slice(1));
}

/* -------------------------------------------------------------------------- */
/* Matching                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The characters a command name is built from and that a needle may leave out.
 * `artemis-skills:code-review` is four words to a reader and one word to
 * someone typing quickly, and both should find it.
 */
function isSeparator(char: string): boolean {
  return char === ':' || char === '_' || char === '-';
}

function withoutSeparators(text: string): string {
  return [...text].filter((char) => !isSeparator(char)).join('');
}

/** Where a word of `name` begins: its start, and after every separator. */
function wordStarts(name: string): readonly number[] {
  const starts = [0];
  for (let at = 1; at < name.length; at += 1) {
    if (!isSeparator(name.charAt(at)) && isSeparator(name.charAt(at - 1))) starts.push(at);
  }
  return starts;
}

/**
 * Where `needle` matches `name`: which word the match began at — 0 being the
 * whole name — and the offsets in `name` of the characters it matched.
 */
function matchName(
  needle: string,
  name: string,
): { readonly word: number; readonly indices: readonly number[] } | null {
  const starts = wordStarts(name);
  for (let word = 0; word < starts.length; word += 1) {
    const indices = consume(needle, name, starts[word] ?? 0);
    if (indices !== null) return { word, indices };
  }
  return null;
}

/**
 * Walk `name` from `start`, skipping its separators, spending `needle` one
 * character at a time. Null the moment a character disagrees: the needle has to
 * be a prefix of the run of words starting there, and a needle that runs off
 * the end of the name is no match either.
 */
function consume(needle: string, name: string, start: number): readonly number[] | null {
  const indices: number[] = [];
  let at = start;
  for (const char of needle) {
    while (at < name.length && isSeparator(name.charAt(at))) at += 1;
    if (at >= name.length || name.charAt(at).toLowerCase() !== char) return null;
    indices.push(at);
    at += 1;
  }
  return indices;
}
