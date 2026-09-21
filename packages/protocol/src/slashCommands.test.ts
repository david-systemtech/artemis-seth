import { describe, expect, it } from 'vitest';

import { canonicalCommandName, hoistSlashCommand, slashTokenAt, slashTokensIn } from './slashCommands.js';

/** The real shape of a reported list: built-ins plus bridged, prefixed entries. */
const COMMANDS = ['compact', 'clear', 'artemis-skills:unslop', '/artemis-skills:code-review'];

describe('canonicalCommandName', () => {
  it('strips a slash the provider put there and leaves a bare name alone', () => {
    expect(canonicalCommandName('/compact')).toBe('compact');
    expect(canonicalCommandName('compact')).toBe('compact');
  });
});

describe('slashTokenAt', () => {
  it('finds the token the cursor is in, wherever it sits in the draft', () => {
    expect(slashTokenAt('/com', 4)).toMatchObject({ name: 'com', start: 0, end: 4, leading: true });
    expect(slashTokenAt('tidy this /uns', 14)).toMatchObject({ name: 'uns', start: 10, end: 14, leading: false });
  });

  it('is not a token on the slash itself — nothing has been typed yet', () => {
    expect(slashTokenAt('/com', 0)).toBeNull();
  });

  it('reads the whole token, not the part before the cursor', () => {
    // Arrowing back into a command to fix a letter must not narrow the menu.
    expect(slashTokenAt('/compact', 4)?.name).toBe('compact');
  });

  it('refuses a slash that is mid-word', () => {
    expect(slashTokenAt('and/or', 6)).toBeNull();
  });

  it('ends the token at whitespace, so arguments are not part of it', () => {
    expect(slashTokenAt('/compact now', 12)).toBeNull();
    expect(slashTokenAt('/compact now', 8)).toMatchObject({ name: 'compact' });
  });

  it('marks a token leading only when nothing but whitespace precedes it', () => {
    expect(slashTokenAt('  /com', 6)?.leading).toBe(true);
    expect(slashTokenAt('a\n/com', 6)?.leading).toBe(false);
  });

  it('keeps a path whole rather than stopping at its inner slashes', () => {
    // The caller needs to see `etc/hosts` so it can decline to offer anything.
    expect(slashTokenAt('read /etc/hosts', 15)?.name).toBe('etc/hosts');
  });
});

describe('slashTokensIn', () => {
  it('finds every token in order', () => {
    expect(slashTokensIn('a /one b /two').map((token) => token.name)).toEqual(['one', 'two']);
  });

  it('ignores a slash that is mid-word', () => {
    expect(slashTokensIn('and/or 3/4')).toEqual([]);
  });

  it('terminates on adjacent slashes', () => {
    expect(slashTokensIn('// /').map((token) => token.name)).toEqual(['/', '']);
  });
});

describe('hoistSlashCommand', () => {
  it('lifts a trailing command to the front, with the rest as its arguments', () => {
    expect(hoistSlashCommand('tidy the changelog /artemis-skills:unslop', COMMANDS)).toBe(
      '/artemis-skills:unslop tidy the changelog',
    );
  });

  it('lifts one from the middle and closes the hole it left', () => {
    expect(hoistSlashCommand('please /compact the conversation', COMMANDS)).toBe('/compact please the conversation');
  });

  it('matches a name the provider reported wearing a slash', () => {
    expect(hoistSlashCommand('the diff /artemis-skills:code-review', COMMANDS)).toBe(
      '/artemis-skills:code-review the diff',
    );
  });

  it('leaves a draft that already leads with a command alone, so a second lift is a no-op', () => {
    const once = hoistSlashCommand('tidy this /compact', COMMANDS);
    expect(once).toBe('/compact tidy this');
    expect(hoistSlashCommand(once, COMMANDS)).toBe(once);
    expect(hoistSlashCommand('/compact and then some', COMMANDS)).toBe('/compact and then some');
  });

  it('does not touch a path, a fraction, or any token that is not a command', () => {
    expect(hoistSlashCommand('look at /etc/hosts', COMMANDS)).toBe('look at /etc/hosts');
    expect(hoistSlashCommand('a 3/4 split', COMMANDS)).toBe('a 3/4 split');
    expect(hoistSlashCommand('try /compactify', COMMANDS)).toBe('try /compactify');
  });

  it('does nothing without a list to check against', () => {
    expect(hoistSlashCommand('tidy this /compact', undefined)).toBe('tidy this /compact');
    expect(hoistSlashCommand('tidy this /compact', [])).toBe('tidy this /compact');
  });

  it('lifts only the first command and leaves the second where it was typed', () => {
    expect(hoistSlashCommand('a /compact b /clear c', COMMANDS)).toBe('/compact a b /clear c');
  });

  it('keeps the shape of a multi-line draft', () => {
    expect(hoistSlashCommand('first line /compact\nsecond line', COMMANDS)).toBe(
      '/compact first line\nsecond line',
    );
    expect(hoistSlashCommand('first line\n/compact\nsecond line', COMMANDS)).toBe(
      '/compact first line\nsecond line',
    );
  });

  it('leaves a command that is all the draft holds exactly as typed', () => {
    expect(hoistSlashCommand('  /compact  ', COMMANDS)).toBe('  /compact  ');
    expect(hoistSlashCommand('\t/compact', COMMANDS)).toBe('\t/compact');
  });

  it('lifts past a draft that opens with a path, which the provider would take for a command', () => {
    // The menu offers `/compact` mid-draft whatever the draft opens with, so
    // the lift has to honour it there too - or the pick comes back as text.
    expect(hoistSlashCommand('/work/foo then /compact', COMMANDS)).toBe('/compact /work/foo then');
    // And a lifted draft is left alone by a second lift.
    expect(hoistSlashCommand('/compact /work/foo then', COMMANDS)).toBe('/compact /work/foo then');
  });
});
