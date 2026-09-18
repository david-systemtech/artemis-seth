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
  SKILL_LIMITS,
  withSkillAlwaysOn,
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
