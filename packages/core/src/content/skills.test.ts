/**
 * Reading the skills on a machine.
 *
 * Driven over real folders in a scratch directory, because everything
 * interesting here is a fact about the disk: a folded YAML description, two
 * accounts whose `skills` is one directory under two names, a folder with no
 * `SKILL.md` in it, a name that exists in an account's folder and the
 * machine's.
 */

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProfileId } from '@rx-artemis/protocol';
import { SKILL_LIMITS } from '@rx-artemis/protocol';

import { listSkills, readSkillDocument, resolveSkills, skillRootsFor } from './skills.js';

const WORK = 'prof-work' as ProfileId;
const HOME = 'prof-home' as ProfileId;

let root: string;
let home: string;
let work: string;
let personal: string;

async function skill(parent: string, name: string, markdown: string): Promise<string> {
  const dir = join(parent, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), markdown);
  return dir;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'artemis-skills-'));
  home = join(root, 'home');
  work = join(root, 'profiles', 'work');
  personal = join(root, 'profiles', 'personal');
  await Promise.all([mkdir(home, { recursive: true }), mkdir(work, { recursive: true }), mkdir(personal, { recursive: true })]);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('readSkillDocument', () => {
  it('reads a folded description as the one line it means', async () => {
    // How most published skills write it, and what a line-by-line reader shows
    // as ">-".
    const dir = await skill(
      home,
      'unslop',
      '---\nname: unslop\ndescription: >-\n  Remove AI writing patterns from prose.\n  Triggers: "unslop", "humanize".\n---\n\n# Unslop\n\nEdit text.\n',
    );

    const document = await readSkillDocument(dir);

    expect(document.description).toBe('Remove AI writing patterns from prose. Triggers: "unslop", "humanize".');
    expect(document.body).toBe('# Unslop\n\nEdit text.\n');
    expect(document.modelInvocable).toBe(true);
    expect(document.userInvocable).toBe(true);
  });

  it('reads the two invocation switches the way the provider does', async () => {
    const manual = await skill(home, 'deploy', '---\ndescription: Ship it.\ndisable-model-invocation: true\n---\nBody.\n');
    const background = await skill(home, 'context', '---\ndescription: Facts.\nuser-invocable: false\n---\nBody.\n');
    // YAML 1.2 calls only true and false booleans; the provider accepts these too.
    const spelled = await skill(home, 'spelled', '---\ndescription: X.\ndisable-model-invocation: yes\nuser-invocable: "off"\n---\nBody.\n');

    expect(await readSkillDocument(manual)).toMatchObject({ modelInvocable: false, userInvocable: true });
    expect(await readSkillDocument(background)).toMatchObject({ modelInvocable: true, userInvocable: false });
    expect(await readSkillDocument(spelled)).toMatchObject({ modelInvocable: false, userInvocable: false });
  });

  it('answers the defaults for a file it cannot read, rather than throwing', async () => {
    expect(await readSkillDocument(join(home, 'not-there'))).toEqual({
      description: '',
      modelInvocable: true,
      userInvocable: true,
      body: '',
    });
    // No frontmatter at all: the whole file is the body.
    const bare = await skill(home, 'bare', 'Just instructions.\n');
    expect(await readSkillDocument(bare)).toMatchObject({ description: '', body: 'Just instructions.\n' });
  });
});

describe('listSkills', () => {
  const accounts = () => [
    { profileId: WORK, configDir: work },
    { profileId: HOME, configDir: personal },
  ];

  it('lists an account’s own skills and the machine’s, one row per name, by name', async () => {
    await skill(join(work, 'skills'), 'work-conventions', '---\ndescription: House rules.\n---\nBody of rules.\n');
    await skill(join(home, '.agents', 'skills'), 'unslop', '---\ndescription: De-slop.\n---\nEdit.\n');
    // Not skills: no SKILL.md, and a hidden folder.
    await mkdir(join(home, '.agents', 'skills', 'leftover'), { recursive: true });
    await skill(join(home, '.agents', 'skills'), '.system', '---\ndescription: hidden\n---\nx\n');

    const skills = await listSkills({ accounts: accounts(), home });

    expect(skills).toEqual([
      {
        name: 'unslop',
        description: 'De-slop.',
        origin: { kind: 'machine' },
        dir: join(home, '.agents', 'skills', 'unslop'),
        modelInvocable: true,
        userInvocable: true,
        bodyChars: 'Edit.'.length,
      },
      {
        name: 'work-conventions',
        description: 'House rules.',
        origin: { kind: 'profile', profileIds: [WORK] },
        dir: join(work, 'skills', 'work-conventions'),
        modelInvocable: true,
        userInvocable: true,
        bodyChars: 'Body of rules.'.length,
      },
    ]);
  });

  it('names every account that shares one skills folder, rather than the first', async () => {
    // The shared-`~/.claude` arrangement: each profile's `skills` is a link to
    // the same directory.
    const shared = join(root, 'dot-claude', 'skills');
    await skill(shared, 'tdd', '---\ndescription: Red, green.\n---\nWrite the test first.\n');
    await symlink(shared, join(work, 'skills'), 'dir');
    await symlink(shared, join(personal, 'skills'), 'dir');

    const skills = await listSkills({ accounts: accounts(), home });

    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({ name: 'tdd', origin: { kind: 'profile', profileIds: [WORK, HOME] } });
  });

  it('lists a name once, as the account’s copy, which is the one that account is given', async () => {
    await skill(join(work, 'skills'), 'unslop', '---\ndescription: Mine.\n---\nMy version.\n');
    await skill(join(home, '.agents', 'skills'), 'unslop', '---\ndescription: Shared.\n---\nShared version.\n');

    const skills = await listSkills({ accounts: accounts(), home });

    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({ description: 'Mine.', origin: { kind: 'profile', profileIds: [WORK] } });
  });

  it('names both accounts when each has its own copy of one name', async () => {
    await skill(join(work, 'skills'), 'review', '---\ndescription: Work review.\n---\nWork body.\n');
    await skill(join(personal, 'skills'), 'review', '---\ndescription: Home review.\n---\nA longer home body.\n');

    const skills = await listSkills({ accounts: accounts(), home });

    // Each account is offered a skill by this name, and a switch thrown on
    // the row reaches both. What the row says and costs is the first copy's.
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      name: 'review',
      description: 'Work review.',
      origin: { kind: 'profile', profileIds: [WORK, HOME] },
    });
  });

  it('lists a skill whose frontmatter is not valid YAML, rather than failing the list', async () => {
    await skill(join(home, '.agents', 'skills'), 'broken', '---\ndescription: [never closed\n---\nStill a body.\n');

    const skills = await listSkills({ accounts: accounts(), home });

    // The frontmatter parser reports bad YAML instead of throwing, so one bad
    // file is one skill with nothing to say for itself - not a pane that
    // cannot open.
    expect(skills).toMatchObject([{ name: 'broken', description: '', bodyChars: 'Still a body.'.length }]);
  });

  it('prices a body past the injection limit at the limit, which is all a run is given', async () => {
    const body = 'x'.repeat(SKILL_LIMITS.body * 4);
    await skill(join(home, '.agents', 'skills'), 'huge', `---\ndescription: Long.\n---\n${body}\n`);

    const [huge] = await listSkills({ accounts: accounts(), home });

    // Composition cuts the body at the limit, so the pane's "adds about N
    // tokens to every run" must not price the three quarters no run receives.
    expect(huge?.bodyChars).toBe(SKILL_LIMITS.body);
  });

  it('is an empty list on a machine with no skills anywhere', async () => {
    expect(await listSkills({ accounts: accounts(), home })).toEqual([]);
    expect(await listSkills({ accounts: [], home })).toEqual([]);
  });
});

describe('resolveSkills', () => {
  it('reads the body a run on that account would be given, in the order asked', async () => {
    const mine = await skill(join(work, 'skills'), 'unslop', '---\ndescription: Mine.\n---\nMy version.\n');
    await skill(join(home, '.agents', 'skills'), 'unslop', '---\ndescription: Shared.\n---\nShared version.\n');
    const tdd = await skill(join(home, '.agents', 'skills'), 'tdd', '---\ndescription: T.\n---\nTest first.\n');

    const forWork = await resolveSkills(['tdd', 'unslop'], skillRootsFor({ profileId: WORK, configDir: work }, home));
    const forHome = await resolveSkills(['unslop'], skillRootsFor({ profileId: HOME, configDir: personal }, home));

    expect(forWork).toEqual([
      { name: 'tdd', dir: tdd, body: 'Test first.\n' },
      { name: 'unslop', dir: mine, body: 'My version.\n' },
    ]);
    // The other account has no copy of its own, so it gets the machine's.
    expect(forHome.map((entry) => entry.body)).toEqual(['Shared version.\n']);
  });

  it('skips a name with no skill behind it, and a skill with nothing in it', async () => {
    await skill(join(home, '.agents', 'skills'), 'hollow', '---\ndescription: Nothing here.\n---\n\n');

    const resolved = await resolveSkills(
      ['not-installed', 'hollow'],
      skillRootsFor({ profileId: WORK, configDir: work }, home),
    );

    expect(resolved).toEqual([]);
  });
});
