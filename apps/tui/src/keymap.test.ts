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

  it('marks the bindings that are decided but not yet wired', () => {
    const planned = KEYMAP.flatMap((group) => group.keys.filter((binding) => binding.planned === true)).flatMap(
      (binding) => binding.keys,
    );
    expect(planned).toContain('Shift+Tab');
    expect(planned).toContain('Ctrl+O');
  });

  it('carries the slash commands exactly as the parser knows them', () => {
    const group = KEYMAP.find((candidate) => candidate.title === SLASH_GROUP_TITLE);
    expect(group).toBeDefined();
    expect(group?.keys.map((binding) => binding.keys)).toEqual(COMMANDS.map((command) => [command.usage]));
    expect(group?.keys.map((binding) => binding.does)).toEqual(COMMANDS.map((command) => command.summary));
  });
});
