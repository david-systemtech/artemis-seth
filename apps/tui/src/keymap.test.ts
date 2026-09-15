/*
 * The map is data, so what there is to test is whether it is *honest*.
 *
 * Three claims. Every group is worth drawing — a title and at least one row in
 * it. No key is claimed twice in one place, which is the check that catches
 * both a map that has drifted and two handlers fighting over a keystroke.
 * And the slash commands are echoed from `COMMANDS` rather than retyped, which
 * is the thing that would silently rot first: a command added to the parser and
 * not to the overlay is a command nobody finds.
 */

import { describe, expect, it } from 'vitest';

import { COMMANDS } from './commands.js';
import { KEYMAP, SLASH_GROUP_TITLE, type KeyContext } from './keymap.js';

describe('KEYMAP', () => {
  it('gives every group a title and something to put under it', () => {
    expect(KEYMAP.length).toBeGreaterThan(0);
    for (const group of KEYMAP) {
      expect(group.title.trim()).not.toBe('');
      expect(group.keys.length).toBeGreaterThan(0);
      for (const binding of group.keys) {
        expect(binding.keys.length).toBeGreaterThan(0);
        for (const key of binding.keys) expect(key.trim()).not.toBe('');
        expect(binding.does.trim()).not.toBe('');
      }
    }
  });

  it('names each group once', () => {
    const titles = KEYMAP.map((group) => group.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('lets no two rows in one context claim the same key', () => {
    const seen = new Map<KeyContext, Map<string, string>>();
    const clashes: string[] = [];
    for (const group of KEYMAP) {
      const inContext = seen.get(group.context) ?? new Map<string, string>();
      seen.set(group.context, inContext);
      for (const binding of group.keys) {
        for (const key of binding.keys) {
          const already = inContext.get(key);
          if (already === undefined) inContext.set(key, group.title);
          else clashes.push(`${group.context}: ${key} is claimed by both "${already}" and "${group.title}"`);
        }
      }
    }
    expect(clashes).toEqual([]);
  });

  /*
   * Shift+Tab and Ctrl+O were `planned` — decided, unwired — and the overlay
   * dimmed them and wrote `(soon)` after them. Both answer a key now, so the
   * claim worth checking has turned over: not that the map remembers to
   * promise them, but that it has stopped promising and started describing.
   */
  it('makes no promise about a key that is wired', () => {
    const planned = new Set(
      KEYMAP.flatMap((group) => group.keys.filter((binding) => binding.planned === true)).flatMap((binding) => binding.keys),
    );
    expect(planned.has('Shift+Tab')).toBe(false);
    expect(planned.has('Ctrl+O')).toBe(false);
  });

  it('carries the slash commands exactly as the parser knows them', () => {
    const group = KEYMAP.find((candidate) => candidate.title === SLASH_GROUP_TITLE);
    expect(group).toBeDefined();
    expect(group?.keys.map((binding) => binding.keys)).toEqual(COMMANDS.map((command) => [command.usage]));
    expect(group?.keys.map((binding) => binding.does)).toEqual(COMMANDS.map((command) => command.summary));
  });
});

/*
 * The rows this pass added.
 *
 * A key that works and is not written down here is a key nobody finds — that
 * is the whole reason the map is data — so what is checked is that each of the
 * newly wired ones is in it, under the context it is answered in.
 */
describe('KEYMAP: the keys the terminal grew', () => {
  const inContext = (context: KeyContext): ReadonlyMap<string, string> => {
    const rows = new Map<string, string>();
    for (const group of KEYMAP) {
      if (group.context !== context) continue;
      for (const binding of group.keys) for (const key of binding.keys) rows.set(key, binding.does);
    }
    return rows;
  };

  it('writes down what works wherever you are', () => {
    const anywhere = inContext('anywhere');
    expect(anywhere.get('Shift+Tab')).toContain('permission mode');
    expect(anywhere.get('Ctrl+O')).toContain('transcript');
    expect(anywhere.get('Esc Esc')).toContain('earlier prompt');
    expect(anywhere.get('?')).toBeDefined();
  });

  it('writes down the composer keys that only its own header used to mention', () => {
    const composer = inContext('composer');
    expect(composer.get('Ctrl+V')).toContain('Paste');
    expect(composer.get('Ctrl+G')).toContain('$EDITOR');
    expect(composer.get('!')).toContain('shell command');
    expect(composer.get('Backspace')).toContain('paste chip');
  });

  it('gives a key that does two things one row that says both', () => {
    // Two rows for one key in one context is what the clash test forbids, and
    // rightly — but Ctrl+S really does two things, and a row naming only one
    // of them would be the map quietly lying about the other.
    const does = inContext('composer').get('Ctrl+S') ?? '';
    expect(does).toContain('search');
    expect(does).toContain('stash');
  });
});
