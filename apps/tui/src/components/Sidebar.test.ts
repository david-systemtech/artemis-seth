/**
 * The order of the rail.
 *
 * "The conversation list is not in order" was reported against the first
 * version, which lifted the current project to the top and sorted the other
 * folders by recency — so the rail rearranged itself whenever a conversation
 * anywhere was touched or the working directory changed. These lock down the
 * desktop's rules instead: folders by name and holding still, conversations
 * inside one newest first, worktrees folded into their repository, and the
 * "… n more" row that stands in for what the cap hides.
 */

import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import type { ProfileId, SessionId, SessionSummary } from '@rx-artemis/protocol';

import { ARCHIVED_FOLDER, countSessions, railRows, Sidebar, type RailRow } from './Sidebar.js';

/** A SessionSummary with only the fields the rail reads. */
function session(
  over: Partial<SessionSummary> & { id: string; cwd: string; updatedAt: number; tag?: string },
): SessionSummary {
  return {
    providerId: 'claude',
    profileId: 'prof_personal' as ProfileId,
    title: over.id,
    ...over,
    id: over.id as SessionId,
  } as SessionSummary;
}

const identity = (cwd: string): string => cwd;
const ALL_OPEN: ReadonlySet<string> = new Set(['/w/api', '/w/web', '/w/zebra', '/archive/alpha', '/w/new', ARCHIVED_FOLDER]);

/** The rows as a compact script: `folder:api`, `session:x`, `more:3`. */
function script(rows: readonly RailRow[]): readonly string[] {
  return rows.map((row) => {
    switch (row.kind) {
      case 'new':
        return 'new';
      case 'new-elsewhere':
        return 'new-elsewhere';
      case 'folder':
        return `folder:${row.label}${row.open ? '' : '(folded)'}`;
      case 'session':
        return `session:${row.session.id}`;
      case 'more':
        return `more:${String(row.hidden)}`;
      default:
        return '?';
    }
  });
}

describe('railRows', () => {
  it('orders folders by name, whatever their conversations have been doing', () => {
    const rows = railRows([
        session({ id: 'z', cwd: '/w/zebra', updatedAt: 300 }),
        session({ id: 'a', cwd: '/w/api', updatedAt: 100 }),
        session({ id: 'w', cwd: '/w/web', updatedAt: 200 }),
      ],
      ALL_OPEN,
      identity,
    );

    expect(script(rows)).toEqual(['new', 'new-elsewhere', 'folder:api', 'session:a', 'folder:web', 'session:w', 'folder:zebra', 'session:z']);
  });

  it('draws no folder for a project with nothing in it, wherever you are standing', () => {
    // Reported: the directory you happen to be in got a heading of its own
    // with no rows under it. A heading promises contents, the working
    // directory is already named in the header and on the settings line, and
    // the rail is a list of conversations rather than of places.
    const rows = railRows([session({ id: 'z', cwd: '/w/zebra', updatedAt: 1 })], ALL_OPEN, identity);

    expect(script(rows)).toEqual(['new', 'new-elsewhere', 'folder:zebra', 'session:z']);
  });

  it('sorts by the name the heading shows, not the path under it', () => {
    const rows = railRows([session({ id: 'x', cwd: '/w/zebra', updatedAt: 1 }), session({ id: 'y', cwd: '/archive/alpha', updatedAt: 2 })],
      new Set(),
      identity,
    );

    expect(script(rows)).toEqual(['new', 'new-elsewhere', 'folder:alpha(folded)', 'folder:zebra(folded)']);
  });

  it('orders conversations inside a folder newest first, whatever order they arrived in', () => {
    const rows = railRows([
        session({ id: 'old', cwd: '/w/api', updatedAt: 100 }),
        session({ id: 'newest', cwd: '/w/api', updatedAt: 300 }),
        session({ id: 'middle', cwd: '/w/api', updatedAt: 200 }),
      ],
      ALL_OPEN,
      identity,
    );

    expect(script(rows)).toEqual(['new', 'new-elsewhere', 'folder:api', 'session:newest', 'session:middle', 'session:old']);
  });

  it('keeps a fixed order when two conversations share a timestamp', () => {
    const tie = [session({ id: 'b', cwd: '/w/api', updatedAt: 5 }), session({ id: 'a', cwd: '/w/api', updatedAt: 5 })];

    expect(script(railRows(tie, ALL_OPEN, identity))).toEqual(script(railRows([...tie].reverse(), ALL_OPEN, identity)));
  });

  it('files a worktree under the repository it was split off from', () => {
    const projectOf = (cwd: string): string => (cwd.startsWith('/w/api') ? '/w/api' : cwd);
    const rows = railRows([
        session({ id: 'main', cwd: '/w/api', updatedAt: 100 }),
        session({ id: 'branch', cwd: '/w/api/.claude/worktrees/feature', updatedAt: 200 }),
      ],
      ALL_OPEN,
      projectOf,
    );

    expect(script(rows)).toEqual(['new', 'new-elsewhere', 'folder:api', 'session:branch', 'session:main']);
    expect(rows[2]).toMatchObject({ kind: 'folder', count: 2 });
  });

  it('shows the newest few of a big folder and a row for the rest, until expanded', () => {
    const many = Array.from({ length: 11 }, (_, i) => session({ id: `s${String(i)}`, cwd: '/w/api', updatedAt: i }));

    const capped = railRows(many, ALL_OPEN, identity);
    expect(script(capped).slice(3)).toEqual([
      'session:s10',
      'session:s9',
      'session:s8',
      'session:s7',
      'session:s6',
      'session:s5',
      'session:s4',
      'session:s3',
      'more:3',
    ]);
    expect(capped[2]).toMatchObject({ kind: 'folder', count: 11 });

    const expanded = railRows(many, ALL_OPEN, identity, () => undefined, new Set(['/w/api']));
    // Two openers, the folder heading, then every conversation.
    expect(script(expanded)).toHaveLength(3 + 11);
    expect(script(expanded).at(-1)).toBe('session:s0');
  });

  it('shows a folded folder as a heading only, with its full count', () => {
    const rows = railRows([session({ id: 'a', cwd: '/w/api', updatedAt: 1 }), session({ id: 'b', cwd: '/w/api', updatedAt: 2 })],
      new Set(['/w/web']),
      identity,
    );

    // `web` was open and empty; it is not drawn at all, so the folded `api`
    // is the only heading and it still carries what it is hiding.
    expect(script(rows)).toEqual(['new', 'new-elsewhere', 'folder:api(folded)']);
    expect(rows[2]).toMatchObject({ kind: 'folder', count: 2 });
  });

  it('files an archived conversation into its own folder at the foot, not its project', () => {
    const rows = railRows(
      [
        session({ id: 'live', cwd: '/w/api', updatedAt: 2 }),
        session({ id: 'put-away', cwd: '/w/api', updatedAt: 3, tag: 'archived' }),
      ],
      new Set(['/w/api', ARCHIVED_FOLDER]),
      identity,
    );

    // Newest first would have put `put-away` at the top of `api`; archiving
    // is what takes it out of the project altogether, and the archive sorts
    // last however the projects are named.
    expect(script(rows)).toEqual(['new', 'new-elsewhere', 'folder:api', 'session:live', 'folder:archived', 'session:put-away']);
  });

  it('keeps the archive folded away, and out of the way, until it is asked for', () => {
    const rows = railRows(
      [session({ id: 'gone', cwd: '/w/api', updatedAt: 1, tag: 'archived' })],
      new Set(),
      identity,
    );

    // The project it came from has nothing left in it, so it is not drawn at
    // all — one archived conversation must not leave an empty heading behind.
    expect(script(rows)).toEqual(['new', 'new-elsewhere', 'folder:archived(folded)']);
  });

  it('labels a row from another account and leaves the current account’s alone', () => {
    const rows = railRows([
        session({ id: 'mine', cwd: '/w/api', updatedAt: 2 }),
        session({ id: 'theirs', cwd: '/w/api', updatedAt: 1, profileId: 'prof_work' as ProfileId }),
      ],
      ALL_OPEN,
      identity,
      (s) => (s.profileId === 'prof_work' ? 'work' : undefined),
    );

    expect(rows[3]).toMatchObject({ kind: 'session' });
    expect(rows[3]).not.toHaveProperty('account');
    expect(rows[4]).toMatchObject({ kind: 'session', account: 'work' });
  });
});

/*
 * Typing at the rail. A list of two hundred conversations is not browsed, and
 * the question these answer is what a query is allowed to do to the shape of
 * the rail: which rows it keeps, which headings survive, what happens to the
 * folds and the caps, and which rows it drops because they are not answers to
 * a question about what already exists.
 */

const searchable: readonly SessionSummary[] = [
  session({ id: 'parser', title: 'Rewrite the parser', cwd: '/w/api', updatedAt: 300, gitBranch: 'main', model: 'opus' }),
  session({ id: 'rail', title: 'Rail filtering', cwd: '/w/web', updatedAt: 200, gitBranch: 'tui/overhaul' }),
  session({ id: 'release', title: 'Ship the release', cwd: '/w/web', updatedAt: 100, gitBranch: 'main' }),
];

describe('railRows, filtered', () => {
  it('keeps the conversations that answer the query, and the headings over them', () => {
    const rows = railRows(searchable, ALL_OPEN, identity, undefined, undefined, { query: 'rail' });

    expect(script(rows)).toEqual(['folder:web', 'session:rail']);
  });

  it('opens the folders it left, however they were folded', () => {
    // Nothing is open, so unfiltered this is two headings and no rows at all.
    const rows = railRows(searchable, new Set(), identity, undefined, undefined, { query: 'rail' });

    expect(script(rows)).toEqual(['folder:web', 'session:rail']);
    expect(rows[0]).toMatchObject({ kind: 'folder', open: true, count: 1 });
  });

  it('drops the two ways to start a new conversation, which are not answers', () => {
    const rows = railRows(searchable, ALL_OPEN, identity, undefined, undefined, { query: 'ship' });

    expect(script(rows)).not.toContain('new');
    expect(script(rows)).not.toContain('new-elsewhere');
    expect(script(rows)).toEqual(['folder:web', 'session:release']);
  });

  it('looks at the branch, the model, the account and the folder, not only the title', () => {
    const branch = railRows(searchable, ALL_OPEN, identity, undefined, undefined, { query: 'overhaul' });
    expect(script(branch)).toEqual(['folder:web', 'session:rail']);

    const model = railRows(searchable, ALL_OPEN, identity, undefined, undefined, { query: 'opus' });
    expect(script(model)).toEqual(['folder:api', 'session:parser']);

    // A project name narrows to the project, not to the conversations that
    // happen to mention it.
    const folder = railRows(searchable, ALL_OPEN, identity, undefined, undefined, { query: 'web' });
    expect(script(folder)).toEqual(['folder:web', 'session:rail', 'session:release']);

    const account = railRows(
      searchable,
      ALL_OPEN,
      identity,
      (candidate) => (candidate.id === 'release' ? 'work' : undefined),
      undefined,
      { query: 'work' },
    );
    expect(script(account)).toEqual(['folder:web', 'session:release']);
  });

  it('shows every match, past the cap that hides conversations when nothing is typed', () => {
    const many = Array.from({ length: 11 }, (_unused, i) =>
      session({ id: `bug${String(i)}`, title: `bugfix ${String(i)}`, cwd: '/w/api', updatedAt: i }),
    );

    const rows = railRows(many, ALL_OPEN, identity, undefined, undefined, { query: 'bugfix' });

    expect(countSessions(rows)).toBe(11);
    expect(script(rows).some((row) => row.startsWith('more:'))).toBe(false);
  });

  it('keeps nothing, and no heading, when the query answers nothing', () => {
    const rows = railRows(searchable, ALL_OPEN, identity, undefined, undefined, { query: 'zzz' });

    expect(rows).toEqual([]);
    expect(countSessions(rows)).toBe(0);
  });

  it('is the rail exactly as it was when nothing is typed', () => {
    const plain = script(railRows(searchable, ALL_OPEN, identity));

    expect(script(railRows(searchable, ALL_OPEN, identity, undefined, undefined, {}))).toEqual(plain);
    expect(script(railRows(searchable, ALL_OPEN, identity, undefined, undefined, { query: '   ' }))).toEqual(plain);
    expect(script(railRows(searchable, ALL_OPEN, identity, undefined, undefined, { pinned: new Set() }))).toEqual(plain);
  });
});

describe('railRows, pinned', () => {
  it('holds a pinned conversation at the top of its folder, whatever has been touched since', () => {
    const rows = railRows(searchable, ALL_OPEN, identity, undefined, undefined, { pinned: new Set(['release']) });

    // `release` is the oldest in `web` and comes first anyway; `parser` is
    // alone in `api` and does not move to the top of the rail.
    expect(script(rows)).toEqual([
      'new',
      'new-elsewhere',
      'folder:api',
      'session:parser',
      'folder:web',
      'session:release',
      'session:rail',
    ]);
  });

  it('orders two pinned conversations between themselves as it orders any two', () => {
    const rows = railRows(
      [
        session({ id: 'old-pin', cwd: '/w/api', updatedAt: 100 }),
        session({ id: 'loose', cwd: '/w/api', updatedAt: 300 }),
        session({ id: 'new-pin', cwd: '/w/api', updatedAt: 200 }),
      ],
      ALL_OPEN,
      identity,
      undefined,
      undefined,
      { pinned: new Set(['old-pin', 'new-pin']) },
    );

    expect(script(rows).slice(3)).toEqual(['session:new-pin', 'session:old-pin', 'session:loose']);
  });
});

/*
 * The rail as it is drawn. Only the parts filtering and pinning added: what a
 * query looks like on screen, what it says it found, and the one glyph that
 * says a conversation is being kept to hand.
 */
describe('Sidebar', () => {
  const draw = (
    rows: readonly RailRow[],
    over: Partial<Parameters<typeof Sidebar>[0]> = {},
  ): string => {
    const { lastFrame } = render(
      createElement(Sidebar, {
        rows,
        selected: 0,
        focused: true,
        currentProject: '/w/api',
        width: 34,
        height: 14,
        loading: false,
        ...over,
      }),
    );
    return lastFrame() ?? '';
  };

  it('draws the query under the title with what it found', () => {
    const rows = railRows(searchable, ALL_OPEN, identity, undefined, undefined, { query: 'rail' });
    const frame = draw(rows, { query: 'rail' });

    expect(frame).toContain('CONVERSATIONS');
    expect(frame).toContain('/ rail');
    expect(frame).toContain('1 found');
    expect(frame).toContain('Rail filtering');
  });

  it('says when a query found nothing, rather than going blank', () => {
    const frame = draw([], { query: 'zzz' });

    expect(frame).toContain('0 found');
    expect(frame).toContain('nothing matches');
  });

  it('offers the filter while nothing is typed and offers to clear it once something is', () => {
    const rows = railRows(searchable, ALL_OPEN, identity);

    expect(draw(rows)).toContain('/ filter');
    expect(draw(rows, { query: 'rail' })).toContain('Esc clears');
    expect(draw(rows, { query: 'rail' })).not.toContain('/ filter');
    expect(draw(rows, { focused: false })).toContain('Tab: conversations');
  });

  it('marks a pinned conversation, and only a pinned one', () => {
    const rows = railRows(searchable, ALL_OPEN, identity, undefined, undefined, { pinned: new Set(['release']) });
    const frame = draw(rows, { pinned: new Set(['release']) });

    expect(frame).toContain('◈ Ship the release');
    expect(frame).not.toContain('◈ Rail filtering');
  });

  it('gives the glyph to what a conversation is doing before what it is to you', () => {
    const rows = railRows(searchable, ALL_OPEN, identity, undefined, undefined, { pinned: new Set(['release']) });
    const frame = draw(rows, {
      pinned: new Set(['release']),
      activity: new Map([['release', 'running' as const]]),
    });

    expect(frame).toContain('◐ Ship the release');
    expect(frame).not.toContain('◈');
  });
});
