/**
 * The prompt that starts a "describe this bank" session.
 *
 * A bank with no `BANK.md` still works — the legacy formats are read as they
 * are — but it cannot say what it is for, how its folders are named, or how
 * a new entry should land, and the agents are left to infer all three. The
 * honest way to get a manifest is a conversation: an agent in the bank's own
 * checkout reads the tree, proposes the manifest, asks the person the few
 * things it cannot infer, and lands the file through the bank's own review
 * path. This is the first message of that conversation. The renderer opens a
 * column in the bank's directory and sends it; nothing else is special about
 * the session.
 *
 * Pure text, kept in the protocol so the desktop and a future server-side
 * starter compose the same words.
 */

export interface DescribeBankInput {
  readonly slug: string;
  /** The checkout, as the run's working directory. */
  readonly path: string;
  /** What the reader made of it so far. */
  readonly format: 'legacy-flat' | 'legacy-projects' | 'manifest' | null;
  readonly name?: string;
}

const FORMAT_WORDS: Readonly<Record<string, string>> = {
  'legacy-flat': 'a flat cerebro bank: a `memories/` folder, optionally grouped as `memories/<org>/<project>/`',
  'legacy-projects': 'a cerebro projects bank: `cerebro.json` declares `layout: projects` and memories sit under `projects/<org>/<project>/memories/`',
  manifest: 'a bank with a `BANK.md` already; this session is to revise it',
};

export function renderDescribeBankPrompt(input: DescribeBankInput): string {
  const known = input.format === null ? 'not yet recognised as a bank by Artemis' : (FORMAT_WORDS[input.format] ?? input.format);
  return [
    `Describe the memory bank \`${input.slug}\` in this directory (${input.path}) by writing its \`BANK.md\`, and land it through the bank's own review path.`,
    '',
    `Artemis currently reads it as ${known}. A \`BANK.md\` at the root is what lets it say, in its own words, what it holds and how it is kept. The frontmatter is the machine-readable half; the body is the instructions to agents.`,
    '',
    'Do this in order:',
    '1. Read the tree: the top-level folders, a few memory files, any README, AGENTS.md, INDEX.md or cerebro.json. Work out where the memories are (a glob), what the folder levels mean (a scope template such as `projects/{org}/{project}/` or `brands/{brand}/{system}/`), what frontmatter the entries carry, and how changes reach the remote today (pull requests, direct commits, or read-only).',
    '2. Propose the manifest, and ask the user only what you cannot infer: the one-line description ("what it holds, and when to use it"), whether pull requests should merge automatically, and anything about the folder levels that the tree does not settle. Ask in one message, with your best guess as the default for each.',
    '3. Write `BANK.md` with this shape (every key but `name` and `description` is optional and falls back to the cerebro defaults):',
    '```yaml',
    '---',
    `name: ${input.name ?? input.slug}`,
    'description: <what it holds, then "Use when ...">',
    'memories:',
    '  glob: <where the memory files are, e.g. projects/*/*/memories/**/*.md>',
    '  scope: <what the folders mean, e.g. projects/{org}/{project}/>',
    '  schema: cerebro',
    'docs:',
    '  glob: <entry points worth surfacing, e.g. projects/**/{PROJECT,HANDOFF}.md>',
    'index: <a bank-provided index file such as INDEX.md, if there is one>',
    'write:',
    '  place: <where a new entry goes, e.g. projects/{org}/{project}/memories/{name}.md>',
    '  land: pull-request | commit | none',
    '  merge: auto | review',
    '---',
    '# How agents use this bank',
    '<fold in the existing AGENTS.md or README guidance; keep it under a screen>',
    '```',
    '4. Keep any existing `cerebro.json` and `AGENTS.md` in place: older readers still use them. If the body of `BANK.md` now carries the instructions, `cerebro.json` may keep naming `AGENTS.md` for them.',
    '5. Land it the way the bank lands changes: on a branch with a pull request when it has a remote, or a commit when it does not. Then say in one line what you wrote and where it landed.',
    '',
    'Do not invent folders, do not move any memory, and do not write secrets. If the tree is ambiguous, ask rather than guess.',
  ].join('\n');
}
