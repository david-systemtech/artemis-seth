import { describe, expect, it } from 'vitest';

import { COMMANDS, completeCommand, matchCommands, parseCommand, completeProviderCommand } from './commands.js';

describe('parseCommand', () => {
  it('recognises every listed command by name', () => {
    for (const spec of COMMANDS) {
      expect(parseCommand(`/${spec.name}`)).toEqual({ name: spec.name, args: '' });
    }
  });

  it('keeps arguments, trimmed, with their case', () => {
    expect(parseCommand('/model  Fable  ')).toEqual({ name: 'model', args: 'Fable' });
    expect(parseCommand('/mode plan')).toEqual({ name: 'mode', args: 'plan' });
  });

  it('is case-insensitive on the word and tolerates leading whitespace', () => {
    expect(parseCommand('  /QUIT')).toEqual({ name: 'quit', args: '' });
  });

  it('resolves aliases', () => {
    expect(parseCommand('/exit')?.name).toBe('quit');
    expect(parseCommand('/q')?.name).toBe('quit');
    expect(parseCommand('/?')?.name).toBe('help');
    expect(parseCommand('/account')?.name).toBe('profile');
  });

  it("leaves messages and the provider's own slash commands alone", () => {
    expect(parseCommand('hello')).toBeNull();
    expect(parseCommand('/compact')).toBeNull();
    expect(parseCommand('/')).toBeNull();
    expect(parseCommand('/ model')).toBeNull();
    expect(parseCommand('a /model')).toBeNull();
  });
});

describe('completeCommand', () => {
  it('lists everything for an empty prefix and narrows by name', () => {
    expect(completeCommand('')).toHaveLength(COMMANDS.length);
    // `model` and `mode` by name, then `/handoff` by its `move` alias: a row
    // found by an alias sorts behind every row found by its own name.
    expect(completeCommand('/mo').map((command) => command.name)).toEqual(['model', 'mode', 'handoff']);
    expect(completeCommand('zzz')).toEqual([]);
  });
});

/*
 * Reaching a bridged skill by the name a person thinks of.
 *
 * Skills arrive from the content bridge fully qualified — the marketplace's
 * name, a colon, then the command — and reported as "I cannot see my skills
 * when I type /". They were reachable, but only by typing the plugin's name
 * first, which is not how anyone looks for `code-review`.
 */
describe('completeProviderCommand', () => {
  const commands = ['deep-research', 'artemis-skills:code-review', 'artemis-skills:grilling', 'compact'];

  it('finds a skill by the part after the colon', () => {
    expect(completeProviderCommand('/code', commands)).toEqual(['artemis-skills:code-review']);
    expect(completeProviderCommand('/gril', commands)).toEqual(['artemis-skills:grilling']);
  });

  it('still matches the whole name, and puts those first', () => {
    expect(completeProviderCommand('/artemis-skills:gril', commands)).toEqual(['artemis-skills:grilling']);
    // `c` matches `compact` outright and `code-review` after its colon; the
    // one that matched as typed leads.
    expect(completeProviderCommand('/c', commands)).toEqual(['compact', 'artemis-skills:code-review']);
  });

  it('lists everything for a bare slash, and nothing for a miss', () => {
    expect(completeProviderCommand('/', commands)).toEqual(commands);
    expect(completeProviderCommand('/nothing-like-this', commands)).toEqual([]);
  });
});

describe('what is left for the provider', () => {
  it('does not swallow /plan, which is the provider’s own command', () => {
    // The file's rule: a `/command` the TUI does not own goes to the agent,
    // because providers have slash commands of their own. `/plan` was
    // aliased to `/usage` — a plan-*limits* readout — and Claude Code's real
    // `/plan` never arrived.
    expect(parseCommand('/plan')).toBeNull();
    expect(parseCommand('/plan add tests first')).toBeNull();
  });
});

/*
 * The menu under the composer.
 *
 * Every rule here exists so that the top row can be run without reading it:
 * the needle reaches a command the way a person would reach for it, and when it
 * reaches nothing at all the composer knows to send the text to the agent
 * instead of guessing.
 */
describe('matchCommands', () => {
  const providers = ['deep-research', 'artemis-skills:code-review', 'artemis-skills:grilling', 'compact'];
  const usages = (matches: readonly { usage: string }[]): readonly string[] => matches.map((match) => match.usage);

  it('ranks a whole name first, then an alias, then the provider', () => {
    const matched = matchCommands('/c', providers);
    // `copy`, `check` and `cwd` by name, in the order they are declared;
    // `continue`, `changes` and `clear` are aliases, again in the order the
    // commands they mean are declared; `compact` is the provider's own, and
    // `code-review` only matched a word inside its name.
    expect(usages(matched)).toEqual([
      '/copy',
      '/check [command|off|now]',
      '/cwd',
      '/resume',
      '/diff',
      '/new',
      '/compact',
      '/artemis-skills:code-review',
    ]);
    expect(matched.map((match) => match.rank)).toEqual([0, 0, 0, 1, 1, 1, 3, 5]);
  });

  it('leaves this terminal\'s own commands out when asked for the provider\'s only', () => {
    // What the composer passes for a token in the middle of a sentence: only a
    // provider command can be lifted to the front of the message on send, so
    // only a provider command is offered there.
    expect(usages(matchCommands('/c', providers, { providerOnly: true }))).toEqual([
      '/compact',
      '/artemis-skills:code-review',
    ]);
  });

  it('matches a word inside a name, which is how a bridged skill is reachable', () => {
    expect(usages(matchCommands('/review', providers))).toEqual(['/artemis-skills:code-review']);
    expect(usages(matchCommands('/gril', providers))).toEqual(['/artemis-skills:grilling']);
    // The whole name still matches, and sorts above a word-inside match.
    expect(usages(matchCommands('/artemisskills', providers))).toEqual([
      '/artemis-skills:code-review',
      '/artemis-skills:grilling',
    ]);
  });

  it('skips the separators in a name, and the ones that were typed', () => {
    expect(usages(matchCommands('/codereview', providers))).toEqual(['/artemis-skills:code-review']);
    expect(usages(matchCommands('/code-rev', providers))).toEqual(['/artemis-skills:code-review']);
    expect(usages(matchCommands('/deepresearch', providers))).toEqual(['/deep-research']);
  });

  it('finds a command by any of its aliases, and bolds nothing when it does', () => {
    const quit = matchCommands('/exit');
    expect(quit.map((match) => match.usage)).toEqual(['/quit']);
    expect(quit[0]?.rank).toBe(1);
    // The letters typed are nowhere in `/quit`, so there is nothing to bold.
    expect(quit[0]?.indices).toEqual([]);
    expect(usages(matchCommands('/clear'))).toEqual(['/new']);
    expect(usages(matchCommands('/?'))).toEqual(['/help']);
  });

  it('offers one row per command however many ways it was found', () => {
    // `/model` matches its own name and the alias `models`; it is one row, at
    // the better of the two tiers.
    const matched = matchCommands('/model');
    expect(usages(matched)).toEqual(['/model']);
    expect(matched[0]?.rank).toBe(0);
  });

  it('reports where it matched, separators passed over', () => {
    expect(matchCommands('/mo')[0]).toMatchObject({ usage: '/model', indices: [1, 2] });
    // The `-` at offset 20 of `/artemis-skills:code-review` was never typed, so
    // it is not one of the characters to bold.
    expect(matchCommands('/codereview', providers)[0]?.indices).toEqual([16, 17, 18, 19, 21, 22, 23, 24, 25, 26]);
    expect(matchCommands('/review', providers)[0]?.indices).toEqual([21, 22, 23, 24, 25, 26]);
  });

  it('returns nothing for a typo, and does not fuzz its way to a match', () => {
    expect(matchCommands('/mdoel', providers)).toEqual([]);
    // A needle has to be a prefix of a run of words: the letters of `review`
    // minus its first are not, and neither are its initials.
    expect(matchCommands('/eview', providers)).toEqual([]);
    expect(matchCommands('/crv', providers)).toEqual([]);
  });

  it('lists everything for a lone slash, the TUI’s own first', () => {
    const matched = matchCommands('/', providers);
    expect(usages(matched)).toEqual([...COMMANDS.map((command) => command.usage), ...providers.map((name) => `/${name}`)]);
    // And for the buffer the composer really holds, slash and all.
    expect(usages(matchCommands('', providers))).toEqual(usages(matched));
  });

  it('says where a provider row came from, since its name cannot', () => {
    expect(matchCommands('/gril', providers)[0]?.summary).toBe('skill');
    expect(matchCommands('/compact', providers)[0]?.summary).toBe('provider command');
  });

  it('keys every row so the TUI’s and the provider’s cannot collide', () => {
    const matched = matchCommands('/', ['help', ...providers]);
    expect(new Set(matched.map((match) => match.key)).size).toBe(matched.length);
  });
});

/*
 * The commands the overhaul added, and the words people reach for instead.
 *
 * All six are about the conversation that has already happened rather than
 * about the next turn — what it said, what it wrote, what it is called — which
 * is why they are worth aliases at all: someone who wants the diff types
 * `/changes` as readily as `/diff`, and a command that answers only to its own
 * name is one a person has to remember rather than guess.
 */
describe('the conversation commands', () => {
  it('parses each of them by name, arguments and all', () => {
    expect(parseCommand('/copy')).toEqual({ name: 'copy', args: '' });
    expect(parseCommand('/diff')).toEqual({ name: 'diff', args: '' });
    expect(parseCommand('/undo')).toEqual({ name: 'undo', args: '' });
    expect(parseCommand('/pin')).toEqual({ name: 'pin', args: '' });
    expect(parseCommand('/export  notes/session.md ')).toEqual({ name: 'export', args: 'notes/session.md' });
    // The case of a title is the user's; only the command word is folded.
    expect(parseCommand('/TITLE The Rail Rewrite')).toEqual({ name: 'title', args: 'The Rail Rewrite' });
  });

  it('answers to the word rather than the name', () => {
    expect(parseCommand('/save out.md')).toEqual({ name: 'export', args: 'out.md' });
    expect(parseCommand('/changes')?.name).toBe('diff');
    expect(parseCommand('/revert')?.name).toBe('undo');
    expect(parseCommand('/rename Rail')).toEqual({ name: 'title', args: 'Rail' });
    expect(parseCommand('/name Rail')).toEqual({ name: 'title', args: 'Rail' });
  });

  it('draws each of them with its arguments spelled out', () => {
    const usageOf = (name: string): string | undefined => COMMANDS.find((spec) => spec.name === name)?.usage;
    // The row is the whole of what the menu says about how to call it.
    expect(usageOf('export')).toBe('/export [file]');
    expect(usageOf('title')).toBe('/title <name>');
    expect(usageOf('copy')).toBe('/copy');
  });

  it('finds them in the menu by name and by alias', () => {
    expect(completeCommand('/und').map((command) => command.name)).toEqual(['undo']);
    expect(completeCommand('/pin').map((command) => command.name)).toEqual(['pin']);
    // `name` and `rename` both mean `/title`, and one row is offered however
    // many ways it was found.
    const renamed = matchCommands('/rename');
    expect(renamed.map((match) => match.usage)).toEqual(['/title <name>']);
    expect(renamed[0]?.rank).toBe(1);
    expect(matchCommands('/changes').map((match) => match.usage)).toEqual(['/diff']);
  });

  it('leaves the provider’s own neighbours alone', () => {
    // `/pin` is the TUI's; `/plan` and `/compact` are Claude Code's, and a
    // word that merely starts the same way must not swallow them.
    expect(parseCommand('/plan')).toBeNull();
    expect(parseCommand('/compact')).toBeNull();
    expect(parseCommand('/exports')).toBeNull();
    expect(parseCommand('/copycat')).toBeNull();
  });
});

describe('the turn ledger, the card of asks, and the snippets', () => {
  it('parses each of them, with their words', () => {
    expect(parseCommand('/asks')).toEqual({ name: 'asks', args: '' });
    expect(parseCommand('/timeline')).toEqual({ name: 'timeline', args: '' });
    expect(parseCommand('/snip fix-tests apps/tui')).toEqual({ name: 'snip', args: 'fix-tests apps/tui' });
  });

  it('answers to the words people reach for', () => {
    expect(parseCommand('/waiting')?.name).toBe('asks');
    expect(parseCommand('/turns')?.name).toBe('timeline');
    expect(parseCommand('/snippets')?.name).toBe('snip');
  });

  /*
   * `/snip` is the one command with subcommands, and they are the whole reason
   * the parser does nothing clever with them: everything after the word is one
   * string, so `save` can be followed by a template with line breaks in it and
   * arrive intact.
   */
  it('hands /snip its subcommands as words rather than parsing them', () => {
    expect(parseCommand('/snip')).toEqual({ name: 'snip', args: '' });
    expect(parseCommand('/snip --examples')).toEqual({ name: 'snip', args: '--examples' });
    expect(parseCommand('/snip rm fix-tests')).toEqual({ name: 'snip', args: 'rm fix-tests' });
    // The line breaks in a saved template survive the parse, which is what
    // makes `$0` on a line of its own a shape somebody can type.
    expect(parseCommand('/snip save notes first line\nsecond line')).toEqual({
      name: 'snip',
      args: 'save notes first line\nsecond line',
    });
  });

  it('says in the menu that the name is optional, since the bare command is the list', () => {
    const spec = COMMANDS.find((candidate) => candidate.name === 'snip');
    expect(spec?.usage).toBe('/snip [name] [words]');
    expect(spec?.summary).toContain('save');
    expect(spec?.summary).toContain('--examples');
  });
});

/*
 * `/check`, whose three words are not subcommands to the parser.
 *
 * Everything after the name is one string, exactly as `/snip`'s is, and for a
 * sharper reason: a check command is a shell line. `pnpm lint && pnpm test` has
 * to arrive with its `&&`, and a parser that split on whitespace or recognised
 * `off` as a token would be a parser deciding which shell lines are allowed.
 */
describe('/check', () => {
  it('parses, and answers to the plural as well', () => {
    expect(parseCommand('/check')).toEqual({ name: 'check', args: '' });
    expect(parseCommand('/checks')).toEqual({ name: 'check', args: '' });
    expect(parseCommand('/checks off')).toEqual({ name: 'check', args: 'off' });
  });

  it('hands the whole line over, shell operators and all', () => {
    expect(parseCommand('/check pnpm lint && pnpm -w test')).toEqual({
      name: 'check',
      args: 'pnpm lint && pnpm -w test',
    });
    // The case of a command is the shell's business, not the parser's; only the
    // word after the slash is folded.
    expect(parseCommand('/CHECK Make Test')).toEqual({ name: 'check', args: 'Make Test' });
    expect(parseCommand('/check now')).toEqual({ name: 'check', args: 'now' });
  });

  it('says in the menu that the bare command is the readout', () => {
    const spec = COMMANDS.find((candidate) => candidate.name === 'check');
    expect(spec?.usage).toBe('/check [command|off|now]');
    expect(spec?.summary).toContain('after the agent edits');
    expect(completeCommand('/chec').map((command) => command.name)).toEqual(['check']);
  });

  it('leaves the neighbours it starts like alone', () => {
    // `/changes` is `/diff`'s alias and has to stay that way, and a provider's
    // `/checkpoint` is the provider's.
    expect(parseCommand('/changes')?.name).toBe('diff');
    expect(parseCommand('/checkpoint')).toBeNull();
  });
});

/*
 * The hand-off, typed.
 *
 * Its key is Alt+H, and Alt is a modifier plenty of terminals eat, remap or
 * send as something else. A command is the way in that no terminal can take
 * away, which is the whole reason this one exists rather than the key standing
 * on its own.
 */
describe('/handoff', () => {
  it('parses, and answers to the word for what it does', () => {
    expect(parseCommand('/handoff')).toEqual({ name: 'handoff', args: '' });
    expect(parseCommand('/move')?.name).toBe('handoff');
  });

  it('is in the menu, saying what it moves and where to', () => {
    const spec = COMMANDS.find((candidate) => candidate.name === 'handoff');
    expect(spec?.usage).toBe('/handoff');
    expect(spec?.summary).toContain('another account');
    expect(completeCommand('/hand').map((command) => command.name)).toEqual(['handoff']);
  });
});
