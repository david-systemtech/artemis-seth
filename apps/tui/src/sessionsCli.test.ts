/**
 * What `artemis ls` puts on stdout.
 *
 * The formatting only, which is the part with a contract: the table a person
 * reads ids out of, and the JSON Lines a script parses. The read itself is one
 * call to the same host method the rail uses and is left to typecheck.
 *
 * Times are fixed against a fixed `now` so "3h ago" is a fact about the input
 * rather than about when the suite ran.
 */

import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '@rx-artemis/protocol';

import { nothingHere, selectSessions, sessionJson, sessionsJsonl, sessionsTable } from './sessionsCli.js';

const NOW = Date.UTC(2025, 0, 2, 12, 0, 0);
const HOUR = 3_600_000;

function session(partial: Partial<SessionSummary> & { readonly id: string }): SessionSummary {
  return {
    providerId: 'claude',
    profileId: 'prof_work',
    cwd: '/work/artemis',
    title: 'A conversation',
    updatedAt: NOW - HOUR,
    ...partial,
  } as SessionSummary;
}

describe('selectSessions', () => {
  it('keeps only the conversations from the directory it ran in', () => {
    const here = session({ id: 'a', cwd: '/work/artemis' });
    const elsewhere = session({ id: 'b', cwd: '/work/other' });
    expect(selectSessions([here, elsewhere], '/work/artemis', false).map((s) => s.id)).toEqual(['a']);
    expect(selectSessions([here, elsewhere], '/work/artemis', true).map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('ignores a trailing separator on the directory, which --cwd invites', () => {
    const here = session({ id: 'a', cwd: '/work/artemis' });
    expect(selectSessions([here], '/work/artemis/', false)).toHaveLength(1);
  });

  it('orders newest first whatever order it was handed', () => {
    const rows = [
      session({ id: 'old', updatedAt: NOW - 5 * HOUR }),
      session({ id: 'new', updatedAt: NOW - HOUR }),
      session({ id: 'middle', updatedAt: NOW - 3 * HOUR }),
    ];
    expect(selectSessions(rows, '/work/artemis', false).map((s) => s.id)).toEqual(['new', 'middle', 'old']);
  });
});

describe('sessionsTable', () => {
  it('writes id, updated, branch and title, in aligned columns', () => {
    const lines = sessionsTable(
      [
        session({ id: 'aaaa-1111', updatedAt: NOW - 3 * HOUR, gitBranch: 'main', title: 'Fix the parser' }),
        session({ id: 'bb-2', updatedAt: NOW - 30 * HOUR, gitBranch: 'tui/overhaul', title: 'Ship the rail' }),
      ],
      NOW,
    ).split('\n');
    expect(lines[0]).toBe('aaaa-1111  3h ago  main          Fix the parser');
    expect(lines[1]).toBe('bb-2       1d ago  tui/overhaul  Ship the rail');
    // Every row is a whole line, so the last split is the empty tail.
    expect(lines[2]).toBe('');
  });

  it('prints the id whole, because that is what --resume takes', () => {
    const id = '0b9b6a4c-3d1e-4f2a-9c8d-7e6f5a4b3c2d';
    expect(sessionsTable([session({ id })], NOW).startsWith(id)).toBe(true);
  });

  it('holds the column open for a conversation with no branch', () => {
    const table = sessionsTable([session({ id: 'a', gitBranch: 'main' }), session({ id: 'b' })], NOW);
    expect(table.split('\n')[1]).toBe('b  1h ago  —     A conversation');
  });

  it('flattens a title that is really a first prompt', () => {
    const table = sessionsTable([session({ id: 'a', title: 'Have a look\nat this\tplease' })], NOW);
    expect(table).toContain('Have a look at this please');
    expect(table.split('\n')).toHaveLength(2);
  });

  it('clips a long title to one screen line', () => {
    const table = sessionsTable([session({ id: 'a', title: 'x'.repeat(200) })], NOW);
    expect(table).toContain(`${'x'.repeat(71)}…`);
  });

  it('is empty for no conversations, rather than a header over nothing', () => {
    expect(sessionsTable([], NOW)).toBe('');
  });
});

describe('sessionsJsonl', () => {
  it('writes one complete JSON object per line', () => {
    const text = sessionsJsonl([session({ id: 'a' }), session({ id: 'b' })]);
    const lines = text.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => (JSON.parse(line) as { id: string }).id)).toEqual(['a', 'b']);
    expect(text.endsWith('\n')).toBe(true);
  });

  it('carries the seven fields a script picks a conversation by', () => {
    const row = sessionJson(
      session({
        id: 'a',
        title: 'Fix the parser',
        updatedAt: 1234,
        cwd: '/work/artemis',
        gitBranch: 'main',
        model: 'claude-opus-5',
        messageCount: 12,
      }),
    );
    expect(row).toEqual({
      id: 'a',
      title: 'Fix the parser',
      updatedAt: 1234,
      cwd: '/work/artemis',
      gitBranch: 'main',
      model: 'claude-opus-5',
      messageCount: 12,
    });
  });

  it('spells a missing field null, so every line has the same shape', () => {
    const row = sessionJson(session({ id: 'a' }));
    expect(row.gitBranch).toBeNull();
    expect(row.model).toBeNull();
    expect(row.messageCount).toBeNull();
    expect(Object.keys(row)).toEqual(['id', 'title', 'updatedAt', 'cwd', 'gitBranch', 'model', 'messageCount']);
  });

  it('does not flatten or clip the title, which the table does for the eye', () => {
    const long = `${'x'.repeat(200)}\nmore`;
    expect(sessionJson(session({ id: 'a', title: long })).title).toBe(long);
  });
});

describe('nothingHere', () => {
  it('names the directory it looked in, and the flag that looks wider', () => {
    expect(nothingHere('/work/artemis', false)).toContain('/work/artemis');
    expect(nothingHere('/work/artemis', false)).toContain('--all');
    expect(nothingHere('/work/artemis', true)).not.toContain('--all');
  });
});
