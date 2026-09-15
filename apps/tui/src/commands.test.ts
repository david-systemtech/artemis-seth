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
    expect(completeCommand('/mo').map((command) => command.name)).toEqual(['model', 'mode']);
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
    // `cwd` by name; `continue` and `clear` are aliases, in the order the
    // commands they mean are declared; `compact` is the provider's own, and
    // `code-review` only matched a word inside its name.
    expect(usages(matched)).toEqual(['/cwd', '/resume', '/new', '/compact', '/artemis-skills:code-review']);
    expect(matched.map((match) => match.rank)).toEqual([0, 1, 1, 3, 5]);
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
