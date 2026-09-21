/**
 * Slash command matching.
 * ============================================================================
 *
 * The ranking is the whole point of the module, so most of this is about order
 * rather than membership. The case that drove the design is `/cer` finding
 * `artemis-skills:cerebro`: bridged commands are prefixed, the bare name is
 * refused by the provider, and nobody types `artemis-skills:` — so a matcher
 * that only anchored at the head would make every bridged command unreachable.
 */

import { describe, expect, it } from 'vitest';

import { matchSlashCommands, SLASH_RANKS, writeSlashCommand } from './slashCommands';

/** The real shape of the list: built-ins alongside bridged, prefixed entries. */
const COMMANDS = [
  'compact',
  'clear',
  'review',
  'artemis-skills:cerebro',
  'artemis-skills:use-railway',
];

const names = (draft: string, commands: readonly string[] = COMMANDS): readonly string[] =>
  (matchSlashCommands(commands, draft)?.matches ?? []).map((m) => m.name);

describe('matchSlashCommands', () => {
  describe('when the menu opens', () => {
    it('offers everything for a bare slash', () => {
      expect(names('/')).toHaveLength(COMMANDS.length);
      expect(matchSlashCommands(COMMANDS, '/')?.query).toBe('');
    });

    it('opens on a token mid-draft, where the caret is', () => {
      // The whole point of the caret argument: a command is the verb of the
      // sentence and it arrives when the sentence needs it.
      expect(names('tidy this up /cer', COMMANDS)).toEqual(['artemis-skills:cerebro']);
      expect(matchSlashCommands(COMMANDS, 'tidy this up /cer')?.query).toBe('cer');
    });

    it('is about the token under the caret, not the one at the end', () => {
      const draft = '/cer and then /comp';
      expect(matchSlashCommands(COMMANDS, draft, 4)?.query).toBe('cer');
      expect(matchSlashCommands(COMMANDS, draft, draft.length)?.query).toBe('comp');
      // Between the two, in the prose, there is nothing to offer.
      expect(matchSlashCommands(COMMANDS, draft, 8)).toBeNull();
    });

    it('stays shut for a slash that is not a token', () => {
      expect(matchSlashCommands(COMMANDS, 'and/or')).toBeNull();
      expect(matchSlashCommands(COMMANDS, 'fix /this typo')).toBeNull();
    });

    it('closes once the name is complete and arguments begin', () => {
      // The space is the boundary: past it the user is writing arguments, and a
      // menu over their sentence is in the way.
      expect(matchSlashCommands(COMMANDS, '/compact ')).toBeNull();
      expect(matchSlashCommands(COMMANDS, '/artemis-skills:cerebro what changed')).toBeNull();
    });

    it('stays shut when the provider reported no commands', () => {
      // Codex: no user-authored command surface, so nothing to offer and no
      // check needed at the call site.
      expect(matchSlashCommands(undefined, '/c')).toBeNull();
      expect(matchSlashCommands([], '/c')).toBeNull();
    });

    it('closes rather than showing an empty box when nothing matches', () => {
      expect(matchSlashCommands(COMMANDS, '/zzzz')).toBeNull();
    });
  });

  describe('ranking', () => {
    it('finds a bridged command by the name the user knows', () => {
      // The case the ranking exists for.
      expect(names('/cer')).toEqual(['artemis-skills:cerebro']);
    });

    it('puts a full-name prefix above a segment match', () => {
      const matches = matchSlashCommands(['artemis-skills:cerebro', 'artemis-tool'], '/artemis')!;
      expect(matches.matches.map((m) => m.rank)).toEqual([
        SLASH_RANKS.fullPrefix,
        SLASH_RANKS.fullPrefix,
      ]);
    });

    it('puts a segment prefix above a loose substring hit', () => {
      const matches = matchSlashCommands(['artemis-skills:railway', 'derail-something'], '/rail')!;
      expect(matches.matches.map((m) => [m.name, m.rank])).toEqual([
        ['artemis-skills:railway', SLASH_RANKS.segmentPrefix],
        ['derail-something', SLASH_RANKS.contains],
      ]);
    });

    it('sorts equal ranks by the part being read, not by the prefix', () => {
      // Sorting on the full name would file every bridged command under `a`,
      // which is the prefix's fault and not the reader's problem.
      expect(names('/')).toEqual([
        'artemis-skills:cerebro',
        'clear',
        'compact',
        'review',
        'artemis-skills:use-railway',
      ]);
    });

    it('is case-insensitive', () => {
      expect(names('/CER')).toEqual(['artemis-skills:cerebro']);
      expect(names('/Compact')).toEqual(['compact']);
    });
  });

  describe('labelling', () => {
    it('splits a prefixed name into what to read and where it came from', () => {
      const [match] = matchSlashCommands(COMMANDS, '/cer')!.matches;
      expect(match).toMatchObject({
        name: 'artemis-skills:cerebro',
        label: 'cerebro',
        prefix: 'artemis-skills',
      });
    });

    it('leaves a built-in without a prefix', () => {
      const [match] = matchSlashCommands(COMMANDS, '/compact')!.matches;
      expect(match!.label).toBe('compact');
      expect(match!.prefix).toBeUndefined();
    });
  });

  describe('names that arrive wearing a slash', () => {
    // Both forms are in this repository: the Claude CLI reports bare names, and
    // `mockBridge.ts` and the mapper's fixtures report `/compact`.
    const PREFIXED = ['/compact', '/artemis-skills:cerebro'];

    it('strips it rather than offering //compact', () => {
      expect(names('/comp', PREFIXED)).toEqual(['compact']);
    });

    it('inserts a draft with exactly one slash', () => {
      const menu = matchSlashCommands(PREFIXED, '/comp')!;
      expect(writeSlashCommand('/comp', menu.token, menu.matches[0]!.name).text).toBe('/compact ');
    });

    it('still finds a prefixed bridged command by its segment', () => {
      expect(names('/cer', PREFIXED)).toEqual(['artemis-skills:cerebro']);
    });

    it('collapses the two forms of one command into a single row', () => {
      // Otherwise the menu renders two identical rows sharing a React key.
      expect(names('/comp', ['compact', '/compact'])).toEqual(['compact']);
    });

    it('canonicalises a raw provider string handed straight to apply', () => {
      const menu = matchSlashCommands(PREFIXED, '/comp')!;
      expect(writeSlashCommand('/comp', menu.token, '/compact').text).toBe('/compact ');
    });
  });

  it('inserts the canonical name and a space, so the menu closes', () => {
    const menu = matchSlashCommands(COMMANDS, '/cer')!;
    const written = writeSlashCommand('/cer', menu.token, 'artemis-skills:cerebro');
    expect(written.text).toBe('/artemis-skills:cerebro ');
    expect(written.caret).toBe(written.text.length);
    // The trailing space is what makes Enter send on the next press rather than
    // re-accepting the highlighted row.
    expect(matchSlashCommands(COMMANDS, written.text, written.caret)).toBeNull();
  });
});

describe('a token in the middle of a sentence', () => {
  it('is offered only prefix-quality matches', () => {
    // `/rail` finds `derail-something` at the head of a draft, where a slash
    // can only be a command. Mid-sentence that row is noise over what is much
    // more likely to be a path.
    const head = matchSlashCommands(['artemis-skills:railway', 'derail-something'], '/rail')!;
    expect(head.matches.map((m) => m.name)).toEqual(['artemis-skills:railway', 'derail-something']);

    const mid = matchSlashCommands(['artemis-skills:railway', 'derail-something'], 'deploy /rail')!;
    expect(mid.matches.map((m) => m.name)).toEqual(['artemis-skills:railway']);
  });

  it('closes rather than opening on a path that matches nothing well', () => {
    expect(matchSlashCommands(COMMANDS, 'look at /etc/hosts')).toBeNull();
  });

  it('hands Enter back to the composer, and keeps it for a leading token', () => {
    expect(matchSlashCommands(COMMANDS, '/cer')?.enterAccepts).toBe(true);
    expect(matchSlashCommands(COMMANDS, '  /cer')?.enterAccepts).toBe(true);
    expect(matchSlashCommands(COMMANDS, 'tidy this /cer')?.enterAccepts).toBe(false);
  });
});

describe('writeSlashCommand', () => {
  it('writes over the token and leaves the rest of the sentence alone', () => {
    const draft = 'tidy the changelog /cer';
    const menu = matchSlashCommands(COMMANDS, draft)!;
    const written = writeSlashCommand(draft, menu.token, 'artemis-skills:cerebro');
    expect(written.text).toBe('tidy the changelog /artemis-skills:cerebro ');
    expect(written.caret).toBe(written.text.length);
  });

  it('keeps what follows the token, with the caret between the two', () => {
    const draft = 'tidy /cer the changelog';
    const menu = matchSlashCommands(COMMANDS, draft, 9)!;
    const written = writeSlashCommand(draft, menu.token, 'artemis-skills:cerebro');
    expect(written.text).toBe('tidy /artemis-skills:cerebro the changelog');
    // Past the space that was already there rather than past a second one.
    expect(written.text.slice(written.caret)).toBe('the changelog');
  });

  it('leaves the caret out of the token before a line break, so the menu closes', () => {
    // Stopping in front of the break would be the end of the token just
    // written: the menu would reopen on the finished command, and Enter would
    // accept it again, to the same text, for ever.
    const draft = 'first /cer\nsecond';
    const menu = matchSlashCommands(COMMANDS, draft, 10)!;
    const written = writeSlashCommand(draft, menu.token, 'artemis-skills:cerebro');
    expect(written.text).toBe('first /artemis-skills:cerebro \nsecond');
    expect(written.text.slice(written.caret)).toBe('\nsecond');
    expect(matchSlashCommands(COMMANDS, written.text, written.caret)).toBeNull();
  });
});
