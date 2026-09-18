/**
 * The always-on choices and the text they compose into.
 *
 * What is worth pinning is where this can quietly do the wrong thing: a choice
 * shrinking to nobody because a file was hand-edited, a choice evaporating
 * because its skill was briefly absent, a heading over nothing landing in every
 * run, and a body referring to files the model was never told how to find.
 */

import { describe, expect, it } from 'vitest';

import type { ProfileId } from './ids.js';
import {
  alwaysOnSkillNames,
  composeAlwaysOnSkills,
  defaultSkillLibraryDocument,
  isAlwaysOn,
  parseSkillLibraryDocument,
  skillSlashCommand,
  skillSourceIdFor,
  skillSourceLabel,
  skillSourceLimitProblem,
  skillSourceSubdirProblem,
  skillSourceUrlProblem,
  SKILL_LIMITS,
  withoutSkillSource,
  withSkillAlwaysOn,
  withSkillSource,
} from './skills.js';

const WORK = 'prof-work' as ProfileId;
const HOME = 'prof-home' as ProfileId;

describe('parseSkillLibraryDocument', () => {
  it('reads anything unreadable as the defaults, because it is read on the path of every run', () => {
    for (const junk of [null, undefined, 'nope', 7, [], {}, { alwaysOn: 'unslop' }]) {
      expect(parseSkillLibraryDocument(junk)).toEqual(defaultSkillLibraryDocument());
    }
  });

  it('keeps only the fields the contract names, and the first of two entries for one skill', () => {
    const parsed = parseSkillLibraryDocument({
      version: 1,
      alwaysOn: [
        { name: 'unslop', scope: { kind: 'profiles', profileIds: [WORK, WORK, ''] }, smuggled: true },
        { name: 'unslop', scope: { kind: 'all' } },
        { name: '' },
        { name: '   ' },
        'not an entry',
        { name: 'tdd' },
      ],
      extra: 'dropped',
    });

    expect(parsed).toEqual({
      version: 1,
      alwaysOn: [
        { name: 'unslop', scope: { kind: 'profiles', profileIds: [WORK] } },
        { name: 'tdd', scope: { kind: 'all' } },
      ],
    });
  });

  it('keeps a name exactly as given, because it is a folder’s name and not prose', () => {
    // A folder can legally be called " notes ". The list reports it that way and
    // every match downstream is by equality, so a tidied copy would name a
    // different skill: the real row would read "off" and a phantom row for the
    // tidied name would appear as missing.
    const parsed = parseSkillLibraryDocument({
      alwaysOn: [{ name: ' notes ', scope: { kind: 'all' } }, { name: 'notes', scope: { kind: 'all' } }],
    });

    expect(parsed.alwaysOn.map((entry) => entry.name)).toEqual([' notes ', 'notes']);
    expect(isAlwaysOn(parsed, ' notes ')).toBe(true);
  });

  it('reads a scope it cannot make sense of as everyone, never as nobody', () => {
    // A choice the user made must not silently stop applying because a file was
    // edited badly. `all` is what the switch writes; it is the safe reading.
    const parsed = parseSkillLibraryDocument({ alwaysOn: [{ name: 'unslop', scope: { kind: 'profiles' } }] });

    expect(parsed.alwaysOn[0]?.scope).toEqual({ kind: 'all' });
  });
});

describe('withSkillAlwaysOn', () => {
  it('switches a skill on at the end, for every account', () => {
    const one = withSkillAlwaysOn(defaultSkillLibraryDocument(), 'unslop', true);
    const two = withSkillAlwaysOn(one, 'tdd', true);

    expect(two.alwaysOn).toEqual([
      { name: 'unslop', scope: { kind: 'all' } },
      { name: 'tdd', scope: { kind: 'all' } },
    ]);
    expect(isAlwaysOn(two, 'tdd')).toBe(true);
  });

  it('leaves a narrowed scope alone when the skill is switched on again', () => {
    const narrowed = {
      version: 1 as const,
      alwaysOn: [{ name: 'unslop', scope: { kind: 'profiles' as const, profileIds: [WORK] } }],
    };

    // The same document, not an equal one: nothing changed, nothing to save.
    expect(withSkillAlwaysOn(narrowed, 'unslop', true)).toBe(narrowed);
  });

  it('switches it off, and its scope goes with it', () => {
    const on = withSkillAlwaysOn(defaultSkillLibraryDocument(), 'unslop', true);

    expect(withSkillAlwaysOn(on, 'unslop', false).alwaysOn).toEqual([]);
    expect(withSkillAlwaysOn(on, 'never-on', false)).toBe(on);
  });
});

describe('alwaysOnSkillNames', () => {
  it('names the skills that apply to an account, in the order they were switched on', () => {
    const document = parseSkillLibraryDocument({
      alwaysOn: [
        { name: 'unslop', scope: { kind: 'all' } },
        { name: 'work-conventions', scope: { kind: 'profiles', profileIds: [WORK] } },
        { name: 'tdd', scope: { kind: 'all' } },
      ],
    });

    expect(alwaysOnSkillNames(document, WORK)).toEqual(['unslop', 'work-conventions', 'tdd']);
    expect(alwaysOnSkillNames(document, HOME)).toEqual(['unslop', 'tdd']);
  });
});

describe('composeAlwaysOnSkills', () => {
  it('is undefined with nothing to say, so the provider’s own preset goes through untouched', () => {
    expect(composeAlwaysOnSkills([])).toBeUndefined();
    // A heading over nothing, in every run, is noise rather than an instruction.
    expect(composeAlwaysOnSkills([{ name: 'empty', dir: '/skills/empty', body: '  \n ' }])).toBeUndefined();
  });

  it('tells the model to follow the skill unasked, and where its files are', () => {
    const text = composeAlwaysOnSkills([
      { name: 'unslop', dir: '/data/skills/unslop', body: '\n# Unslop\n\nSee PATTERNS.md.\n' },
    ]);

    expect(text).toBe(
      [
        '# Always-on skill: unslop',
        '',
        'Follow this skill for the whole session, without being asked, wherever it applies. Files it mentions are relative to `/data/skills/unslop`.',
        '',
        '# Unslop\n\nSee PATTERNS.md.',
      ].join('\n'),
    );
  });

  it('composes several in the order given, a blank line apart', () => {
    const text = composeAlwaysOnSkills([
      { name: 'one', dir: '/s/one', body: 'First.' },
      { name: 'two', dir: '/s/two', body: 'Second.' },
    ]);

    expect(text?.indexOf('# Always-on skill: one')).toBe(0);
    expect(text).toContain('First.\n\n# Always-on skill: two');
  });

  it('cuts a body past the limit and says where the rest is, rather than dropping the skill', () => {
    const text = composeAlwaysOnSkills([
      { name: 'huge', dir: '/s/huge', body: 'x'.repeat(SKILL_LIMITS.body + 500) },
    ]);

    expect(text).toContain('x'.repeat(SKILL_LIMITS.body));
    expect(text).not.toContain('x'.repeat(SKILL_LIMITS.body + 1));
    expect(text).toContain('Read `/s/huge/SKILL.md` for all of it.');
  });
});

describe('skillSlashCommand', () => {
  it('is the command a Claude session knows a bridged skill by', () => {
    expect(skillSlashCommand('unslop')).toBe('/artemis-skills:unslop');
  });
});

describe('a skill source’s URL', () => {
  it('accepts the three shapes a forge hands out', () => {
    for (const url of [
      'https://github.com/david-systemtech/agent-skills.git',
      'https://git.example.com/team/skills',
      'ssh://git@github.com/david-systemtech/agent-skills.git',
      'git@github.com:david-systemtech/agent-skills.git',
    ]) {
      expect(skillSourceUrlProblem(url), url).toBeNull();
    }
  });

  it('refuses every other transport, because this string is handed to git by the main process', () => {
    // `ext::` runs a command. An allowlist is the only rule that does not need
    // updating when git grows another transport.
    for (const url of ['ext::sh -c touch%20/tmp/x', 'file:///etc', '/home/me/skills', '../skills', 'http://insecure.example/x', 'github.com/a/b']) {
      expect(skillSourceUrlProblem(url), url).not.toBeNull();
    }
  });

  it('refuses a leading hyphen, whitespace, and a host with no repository', () => {
    expect(skillSourceUrlProblem('--upload-pack=touch /tmp/x')).not.toBeNull();
    expect(skillSourceUrlProblem('https://github.com/a/b c')).not.toBeNull();
    expect(skillSourceUrlProblem('https://github.com/')).not.toBeNull();
    expect(skillSourceUrlProblem('   ')).not.toBeNull();
  });

  it('refuses a credential in the URL, and says what to use instead', () => {
    // It would work, which is the problem: a secret in a settings file in plain
    // text, and in every log line that names the source.
    const problem = skillSourceUrlProblem('https://me:secret-token-value@github.com/a/b.git');

    expect(problem).toContain('git credentials');
  });
});

describe('a skill source’s folder', () => {
  it('is a path inside the repository', () => {
    expect(skillSourceSubdirProblem('skills')).toBeNull();
    expect(skillSourceSubdirProblem('packs/writing/skills')).toBeNull();
    for (const subdir of ['', '/etc', '../outside', 'skills/../..', 'C:\\Users', 'a//b']) {
      expect(skillSourceSubdirProblem(subdir), subdir).not.toBeNull();
    }
  });
});

describe('skillSourceIdFor', () => {
  it('names the folder readably, and the same for every spelling of one repository', () => {
    const https = skillSourceIdFor('https://github.com/David-Systemtech/agent-skills.git');

    expect(https).toMatch(/^github-com-david-systemtech-agent-skills-[0-9a-f]{8}$/);
    // One repository is one source on every machine, whichever URL was pasted.
    expect(skillSourceIdFor('git@github.com:david-systemtech/agent-skills.git')).toBe(https);
    expect(skillSourceIdFor('ssh://git@github.com/david-systemtech/agent-skills')).toBe(https);
    expect(skillSourceIdFor(' https://github.com/david-systemtech/agent-skills/ ')).toBe(https);
  });

  it('tells apart two repositories that flatten to the same words', () => {
    expect(skillSourceIdFor('https://example.com/a/b-c')).not.toBe(skillSourceIdFor('https://example.com/a-b/c'));
  });

  it('is only ever safe to use as a folder name', () => {
    expect(skillSourceIdFor('https://example.com/../../etc/passwd')).toMatch(/^[a-z0-9-]+$/);
  });
});

describe('skillSourceLabel', () => {
  it('is how a person says the repository', () => {
    expect(skillSourceLabel('https://github.com/david-systemtech/agent-skills.git')).toBe('david-systemtech/agent-skills');
    expect(skillSourceLabel('git@github.com:david-systemtech/agent-skills.git')).toBe('david-systemtech/agent-skills');
    expect(skillSourceLabel('https://git.example.com/group/sub/skills')).toBe('sub/skills');
  });
});

describe('the sources in the library', () => {
  const URL = 'https://github.com/david-systemtech/agent-skills.git';

  it('adds a source once, however many times the same repository is added', () => {
    const once = withSkillSource(defaultSkillLibraryDocument(), URL);
    const twice = withSkillSource(once, 'git@github.com:david-systemtech/agent-skills.git', 'packs');

    expect(once.sources).toEqual([{ id: skillSourceIdFor(URL), url: URL, subdir: 'skills' }]);
    // The later spelling and folder win; it is still one source, one clone.
    expect(twice.sources).toHaveLength(1);
    expect(twice.sources?.[0]).toMatchObject({ id: skillSourceIdFor(URL), subdir: 'packs' });
  });

  it('removes a source and leaves no empty list behind', () => {
    const withOne = withSkillSource(defaultSkillLibraryDocument(), URL);

    const without = withoutSkillSource(withOne, skillSourceIdFor(URL));

    // Byte-identical to a library that never had one.
    expect(without).toEqual(defaultSkillLibraryDocument());
    expect('sources' in without).toBe(false);
  });

  it('keeps the sources when a skill is switched on or off', () => {
    const library = withSkillSource(defaultSkillLibraryDocument(), URL);

    expect(withSkillAlwaysOn(library, 'unslop', true).sources).toEqual(library.sources);
    expect(withSkillAlwaysOn(withSkillAlwaysOn(library, 'unslop', true), 'unslop', false).sources).toEqual(library.sources);
  });

  it('re-derives a stored id, so a hand-edited file cannot aim the clone folder elsewhere', () => {
    const parsed = parseSkillLibraryDocument({
      alwaysOn: [],
      sources: [
        { id: '../../somewhere-else', url: URL, subdir: 'skills' },
        { id: 'x', url: 'ext::sh -c boom' },
        { id: 'y', url: URL, subdir: '../outside' },
        'not a source',
      ],
    });

    expect(parsed.sources).toEqual([{ id: skillSourceIdFor(URL), url: URL, subdir: 'skills' }]);
  });

  it('reads the sources even when the always-on half is unreadable', () => {
    // A machine's sources are the more expensive half to lose.
    const parsed = parseSkillLibraryDocument({ alwaysOn: 'broken', sources: [{ url: URL }] });

    expect(parsed.alwaysOn).toEqual([]);
    expect(parsed.sources).toHaveLength(1);
  });
});

describe('what the review of the first cut found', () => {
  it('refuses a password in an ssh URL, the one other transport with somewhere to put one', () => {
    expect(skillSourceUrlProblem('ssh://me:secret-token@github.com/a/b.git')).toMatch(/username and token/);
    expect(skillSourceUrlProblem('ssh://:secret@github.com/a/b.git')).toMatch(/username and token/);
    // A bare user is how ssh is addressed, and stays legal in both spellings.
    expect(skillSourceUrlProblem('ssh://git@github.com/a/b.git')).toBeNull();
    expect(skillSourceUrlProblem('ssh://github.com:2222/a/b.git')).toBeNull();
    expect(skillSourceUrlProblem('git@github.com:a/b.git')).toBeNull();
    // And a document on disk that holds one is read without it.
    expect(
      parseSkillLibraryDocument({ version: 1, alwaysOn: [], sources: [{ url: 'ssh://me:secret@github.com/a/b' }] })
        .sources,
    ).toBeUndefined();
  });

  it('never derives an id the validators would refuse, wherever the cut lands', () => {
    // Main holds an id to this alphabet before it removes or pulls a source,
    // so an id outside it would name a row that can be neither.
    const guarded = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
    for (let pad = 60; pad <= 90; pad += 1) {
      const url = `https://example.com/${'a'.repeat(pad)}-/-b/${'c'.repeat(12)}`;
      expect(skillSourceIdFor(url)).toMatch(guarded);
    }
    expect(skillSourceIdFor('https://-/-')).toMatch(guarded);
  });

  it('refuses control characters in the folder, as it does in the URL', () => {
    expect(skillSourceSubdirProblem('skills\u0000')).toMatch(/control characters/);
    expect(skillSourceSubdirProblem('ski\tlls')).toMatch(/control characters/);
    expect(skillSourceSubdirProblem('skills/engineering')).toBeNull();
  });

  it('says when the list is full, rather than dropping the source just added', () => {
    let document = defaultSkillLibraryDocument();
    for (let index = 0; index < 20; index += 1) {
      expect(skillSourceLimitProblem(document, `https://example.com/o/r${String(index)}`)).toBeNull();
      document = withSkillSource(document, `https://example.com/o/r${String(index)}`);
    }
    expect(skillSourceLimitProblem(document, 'https://example.com/o/one-more')).toMatch(/at most 20/);
    // Re-adding one already held replaces it, which is never over the limit.
    expect(skillSourceLimitProblem(document, 'https://example.com/o/r3.git')).toBeNull();
  });
});
