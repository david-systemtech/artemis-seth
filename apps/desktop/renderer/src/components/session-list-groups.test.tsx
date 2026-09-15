/**
 * @vitest-environment jsdom
 *
 * Groups of your own, in the sidebar.
 *
 * The sidebar files every conversation under the directory it ran in, which is
 * a good default and the only one there was. It has one case it cannot answer
 * at all: sessions held on an Artemis Server share a single working directory,
 * so an entire server's history arrives under one heading with nothing to tell
 * a week of unrelated work apart. Groups are the user's own filing on top of
 * that — make one, drag rows into it, drag them back out.
 *
 * What is worth asserting here is not that a heading renders. It is the four
 * places this can quietly do the wrong thing:
 *
 *  1. **A grouped row appearing in both places, or in neither.** The move is a
 *    *lift*: the row has to leave its project heading and turn up under the
 *    group, and the assertions below read the list as an ordered strip rather
 *    than asking whether a title exists somewhere on screen.
 *  2. **A drop doing something on a heading that should refuse it.** Pinned and
 *    Archived are not filing destinations, and a drag carrying anything other
 *    than a session must land nowhere at all.
 *  3. **Filing quietly changing a session's state.** Moving a row into a group
 *    must not pin, unpin, archive or unarchive it — and a pinned session stays
 *    on the pin shelf, because Pinned outranks a group.
 *  4. **A served row behaving differently from a local one.** It is the reason
 *    the feature exists; it is also the row most likely to be special-cased by
 *    accident.
 *
 * Same caveat as the other component tests: `renderer/tsconfig.json` excludes
 * them, so `pnpm typecheck` never sees this file and the assertions are
 * behavioural.
 */

import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { SessionSummary } from '@rx-artemis/protocol';

import { TooltipProvider } from '@/components/ui/tooltip';
import { SessionList } from '@/components/SessionList';
import { SESSION_DRAG_TYPE } from '@/lib/sessionDrag';
import { useApp } from '@/state/store';
import { ALL_CAPABILITIES, seedApp } from '@/state/testkit';

class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', NoopObserver);
vi.stubGlobal('DOMRectReadOnly', class {});
Element.prototype.scrollIntoView ??= function scrollIntoView(): void {};
/* Radix's dismissable layer measures the pointer capture surface. */
Element.prototype.hasPointerCapture ??= function hasPointerCapture(): boolean {
  return false;
};
Element.prototype.releasePointerCapture ??= function releasePointerCapture(): void {};

function session(over: Partial<SessionSummary> & Pick<SessionSummary, 'id'>): SessionSummary {
  return {
    cwd: '/code/api',
    updatedAt: 10,
    title: over.id,
    providerId: 'claude',
    profileId: 'p1',
    ...over,
  } as SessionSummary;
}

/**
 * Two local projects and a server.
 *
 * `/work/SYSTEM-SERVER` holds two rows under one directory, which is the whole
 * complaint: the project heading cannot tell them apart, and only a group can.
 */
const SESSIONS: readonly SessionSummary[] = [
  session({ id: 'Adapter seam', cwd: '/code/api', updatedAt: 30 }),
  session({ id: 'Token refresh', cwd: '/code/api', updatedAt: 20 }),
  session({ id: 'Login redirect', cwd: '/code/web', updatedAt: 10 }),
  session({
    id: 'Served nightly',
    cwd: '/work/SYSTEM-SERVER',
    updatedAt: 40,
    providerId: 'artemis',
    profileId: 'srv',
  }),
];

beforeEach(() => {
  seedApp({
    providers: [
      {
        id: 'claude',
        label: 'Claude',
        capabilities: ALL_CAPABILITIES,
        models: [],
        effortLevels: [],
        available: true,
      },
      {
        id: 'artemis',
        label: 'Artemis Server',
        capabilities: ALL_CAPABILITIES,
        models: [],
        effortLevels: [],
        available: true,
      },
    ],
    activeProviderId: 'claude',
    profiles: [
      { id: 'p1', label: 'Work', providerId: 'claude', configDir: '/home/u/.claude' },
      { id: 'srv', label: 'Server', providerId: 'artemis', configDir: '/home/u/.artemis' },
    ],
    activeProfileId: 'p1',
    cwd: '/code/api',
    workspace: null,
    run: null,
    sessions: SESSIONS,
    sessionsLoading: false,
    sessionsError: null,
    collapsedProjects: [],
    archivedSessions: [],
    archivedExpanded: false,
    pinnedSessions: [],
    pinnedCollapsed: false,
    sessionGroups: [],
    sessionGroupOf: {},
    resumeSessionId: null,
    permissionQueue: [],
    banners: [],
  });
});

afterEach(cleanup);

function mount(): void {
  render(
    <TooltipProvider delayDuration={0}>
      <SessionList />
    </TooltipProvider>,
  );
}

/**
 * The list as an ordered strip of headings and row titles.
 *
 * Document order is row order — the virtualiser pushes its window in index
 * order — so this is what "the row left its project and is under the group"
 * actually looks like on screen. Asking `getByText` whether a title exists
 * somewhere would pass just as happily with the row in the wrong section, or in
 * two sections at once.
 *
 * Headings are matched on their label, which is the last segment of the project
 * path for a project and the user's own word for a group.
 */
function strip(): (string | null)[] {
  return screen
    .getAllByText(
      /^(api|web|SYSTEM-SERVER|Billing|Docs|Pinned|Archived|Adapter seam|Token refresh|Login redirect|Served nightly)$/,
    )
    .map((element) => element.textContent);
}

/** The heading button for a project or a group, by the word on it. */
function heading(name: string): HTMLElement {
  return screen.getByRole('button', { name: new RegExp(`^${name}`) });
}

/**
 * A drag carrying a session, the way the row's `dragstart` writes one.
 *
 * jsdom has no usable `DataTransfer`, and the parts under test only ever ask it
 * two things — what types are on offer, and what the payload says — so the stub
 * answers exactly those. `dropEffect` is deliberately not an own property:
 * Testing Library copies own properties onto a real `DataTransfer` when the
 * environment has one, non-writably, and the handler assigns to it.
 */
function sessionDrag(profileId: string, sessionId: string): object {
  const payload = JSON.stringify({ profileId, sessionId });
  return {
    types: [SESSION_DRAG_TYPE],
    getData: (type: string) => (type === SESSION_DRAG_TYPE ? payload : ''),
  };
}

/** A drag from anywhere else — a URL, a snippet, a file. */
function foreignDrag(): object {
  return {
    types: ['text/plain'],
    getData: () => 'https://example.com',
  };
}

/** Drop a session onto a heading, the two events a real drop delivers. */
function dropOn(target: HTMLElement, transfer: object): void {
  fireEvent.dragOver(target, { dataTransfer: transfer });
  fireEvent.drop(target, { dataTransfer: transfer });
}

/** Make a group called `name` through the UI, and return its id. */
function makeGroup(name: string): string {
  fireEvent.click(screen.getByRole('button', { name: 'New group' }));
  const field = screen.getByLabelText('Rename group: New group');
  fireEvent.change(field, { target: { value: name } });
  fireEvent.keyDown(field, { key: 'Enter' });
  return useApp.getState().sessionGroups.at(-1)!.id;
}

/* -------------------------------------------------------------------------- */
/* Making one                                                                 */
/* -------------------------------------------------------------------------- */

describe('making a group', () => {
  it('creates it and opens its name for typing, in one gesture', () => {
    mount();

    fireEvent.click(screen.getByRole('button', { name: 'New group' }));

    // The group exists and the cursor is already in its name: a heading called
    // "New group" that has to be found and renamed afterwards is two gestures
    // for one intention.
    expect(useApp.getState().sessionGroups).toHaveLength(1);
    expect(screen.getByLabelText('Rename group: New group')).toBeTruthy();
  });

  it('keeps the typed name and draws it as a heading', () => {
    mount();
    makeGroup('Billing');

    expect(useApp.getState().sessionGroups[0]!.name).toBe('Billing');
    expect(heading('Billing')).toBeTruthy();
  });

  it('abandons the rename on Escape, leaving the placeholder name', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'New group' }));
    const field = screen.getByLabelText('Rename group: New group');
    fireEvent.change(field, { target: { value: 'Half typed' } });
    fireEvent.keyDown(field, { key: 'Escape' });

    // The group stays — Escape abandons the *edit*, which is the only thing
    // the user was in the middle of.
    expect(useApp.getState().sessionGroups[0]!.name).toBe('New group');
  });

  it('declines a blank name rather than storing an unclickable heading', () => {
    mount();
    makeGroup('Billing');
    fireEvent.doubleClick(heading('Billing'));
    const field = screen.getByLabelText('Rename group: Billing');
    fireEvent.change(field, { target: { value: '   ' } });
    fireEvent.keyDown(field, { key: 'Enter' });

    // The heading is the only handle on a group: it folds it, opens its menu
    // and takes its drops. A blank one would own its sessions invisibly.
    expect(useApp.getState().sessionGroups[0]!.name).toBe('Billing');
  });

  it('sits above the project headings and below Pinned', () => {
    mount();
    makeGroup('Billing');

    expect(strip()).toEqual([
      'Billing',
      'api',
      'Adapter seam',
      'Token refresh',
      'SYSTEM-SERVER',
      'Served nightly',
      'web',
      'Login redirect',
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* Filing by drag                                                             */
/* -------------------------------------------------------------------------- */

describe('dragging a session into a group', () => {
  it('lifts the row out of its project and puts it under the group', () => {
    mount();
    makeGroup('Billing');

    dropOn(heading('Billing'), sessionDrag('p1', 'Adapter seam'));

    expect(strip()).toEqual([
      'Billing',
      'Adapter seam',
      'api',
      'Token refresh',
      'SYSTEM-SERVER',
      'Served nightly',
      'web',
      'Login redirect',
    ]);
  });

  it('remembers the filing by session key, beside the pins', () => {
    mount();
    const id = makeGroup('Billing');

    dropOn(heading('Billing'), sessionDrag('p1', 'Adapter seam'));

    expect(useApp.getState().sessionGroupOf).toEqual({ 'p1:Adapter seam': id });
  });

  it('moves a row straight from one group to another', () => {
    mount();
    makeGroup('Billing');
    const docs = makeGroup('Docs');
    dropOn(heading('Billing'), sessionDrag('p1', 'Adapter seam'));

    dropOn(heading('Docs'), sessionDrag('p1', 'Adapter seam'));

    // One membership, not two: a session is in at most one group.
    expect(useApp.getState().sessionGroupOf).toEqual({ 'p1:Adapter seam': docs });
    expect(within(heading('Billing')).getByText('0')).toBeTruthy();
    expect(within(heading('Docs')).getByText('1')).toBeTruthy();
  });

  it('puts a row back under its project when dropped on a project heading', () => {
    mount();
    makeGroup('Billing');
    dropOn(heading('Billing'), sessionDrag('p1', 'Adapter seam'));

    dropOn(heading('api'), sessionDrag('p1', 'Adapter seam'));

    expect(useApp.getState().sessionGroupOf).toEqual({});
    expect(strip()).toEqual([
      'Billing',
      'api',
      'Adapter seam',
      'Token refresh',
      'SYSTEM-SERVER',
      'Served nightly',
      'web',
      'Login redirect',
    ]);
  });

  it('files a session held on an Artemis Server exactly like a local one', () => {
    // The case the feature exists for. The row's key is the desktop's server
    // profile plus the session id, and nothing about the served path is
    // special to the filing.
    mount();
    const id = makeGroup('Billing');

    dropOn(heading('Billing'), sessionDrag('srv', 'Served nightly'));

    expect(useApp.getState().sessionGroupOf).toEqual({ 'srv:Served nightly': id });
    // Its project heading goes with it: that heading held nothing else, which
    // is exactly what an empty server directory should look like once its
    // conversations have been filed.
    expect(strip()).toEqual([
      'Billing',
      'Served nightly',
      'api',
      'Adapter seam',
      'Token refresh',
      'web',
      'Login redirect',
    ]);
  });

  it('ignores a drag that is not carrying a session', () => {
    // A URL from the browser or a file from Finder reaches the same handler;
    // the type is what decides, because the payload is unreadable mid-drag.
    mount();
    makeGroup('Billing');

    dropOn(heading('Billing'), foreignDrag());

    expect(useApp.getState().sessionGroupOf).toEqual({});
  });

  it('ignores a drag naming a session that is no longer in the list', () => {
    mount();
    makeGroup('Billing');

    dropOn(heading('Billing'), sessionDrag('p1', 'vanished-mid-drag'));

    expect(useApp.getState().sessionGroupOf).toEqual({});
  });

  it('does nothing when a session is dropped on Pinned or Archived', () => {
    // Neither is a filing destination — one is the shelf at eye level, the
    // other the drawer under the desk, and both are reached by their own
    // deliberate action rather than by a drag that happened to end there.
    mount();
    makeGroup('Billing');
    act(() => {
      useApp.setState({ pinnedSessions: ['p1:Token refresh'], archivedExpanded: true });
    });

    dropOn(heading('Pinned'), sessionDrag('p1', 'Adapter seam'));

    expect(useApp.getState().sessionGroupOf).toEqual({});
  });
});

/* -------------------------------------------------------------------------- */
/* Filing from the menu                                                       */
/* -------------------------------------------------------------------------- */

describe('the row menu’s Move to group', () => {
  /** Right-click a row and open the submenu. */
  async function openMoveMenu(title: string): Promise<void> {
    fireEvent.contextMenu(screen.getByText(title));
    const trigger = await screen.findByRole('menuitem', { name: 'Move to group' });
    fireEvent.click(trigger);
    await screen.findByRole('menu', { name: 'Move to group' });
  }

  it('lists the groups and files the row into the one picked', async () => {
    mount();
    const id = makeGroup('Billing');
    await openMoveMenu('Adapter seam');

    fireEvent.click(screen.getByRole('menuitem', { name: 'Billing' }));

    expect(useApp.getState().sessionGroupOf).toEqual({ 'p1:Adapter seam': id });
  });

  it('offers the way out only for a row that is in a group', async () => {
    mount();
    makeGroup('Billing');
    await openMoveMenu('Adapter seam');
    expect(screen.queryByRole('menuitem', { name: 'Remove from group' })).toBeNull();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Billing' }));
    await openMoveMenu('Adapter seam');

    expect(screen.getByRole('menuitem', { name: 'Remove from group' })).toBeTruthy();
  });

  it('makes a group and files the row into it in one step', async () => {
    mount();
    await openMoveMenu('Adapter seam');

    fireEvent.click(screen.getByRole('menuitem', { name: 'New group…' }));

    const groups = useApp.getState().sessionGroups;
    expect(groups).toHaveLength(1);
    expect(useApp.getState().sessionGroupOf).toEqual({ 'p1:Adapter seam': groups[0]!.id });
    // And the new heading is waiting to be named, as it is from the button.
    expect(screen.getByLabelText('Rename group: New group')).toBeTruthy();
  });
});

/* -------------------------------------------------------------------------- */
/* Living with them                                                           */
/* -------------------------------------------------------------------------- */

describe('a group in the list', () => {
  it('folds its rows away and keeps its count', () => {
    mount();
    makeGroup('Billing');
    dropOn(heading('Billing'), sessionDrag('p1', 'Adapter seam'));

    fireEvent.click(heading('Billing'));

    expect(screen.queryByText('Adapter seam')).toBeNull();
    expect(heading('Billing').getAttribute('aria-expanded')).toBe('false');
    // The number is a fact about the group, not about what is on screen.
    expect(within(heading('Billing')).getByText('1')).toBeTruthy();
    expect(useApp.getState().sessionGroups[0]!.collapsed).toBe(true);
  });

  it('gives its sessions back to their projects when it is deleted', async () => {
    mount();
    makeGroup('Billing');
    dropOn(heading('Billing'), sessionDrag('p1', 'Adapter seam'));

    fireEvent.contextMenu(heading('Billing'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete group' }));

    // Nothing is destroyed: the row is back under the project it ran in, which
    // is where it would have been had the group never existed.
    expect(useApp.getState().sessionGroups).toEqual([]);
    expect(useApp.getState().sessionGroupOf).toEqual({});
    expect(strip()).toEqual([
      'api',
      'Adapter seam',
      'Token refresh',
      'SYSTEM-SERVER',
      'Served nightly',
      'web',
      'Login redirect',
    ]);
  });

  it('renames from its own menu', async () => {
    mount();
    makeGroup('Billing');

    fireEvent.contextMenu(heading('Billing'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    const field = await screen.findByLabelText('Rename group: Billing');
    fireEvent.change(field, { target: { value: 'Invoices' } });
    fireEvent.keyDown(field, { key: 'Enter' });

    expect(heading('Invoices')).toBeTruthy();
    // The id is untouched, so the sessions in it do not move for a rename.
    expect(useApp.getState().sessionGroups[0]!.name).toBe('Invoices');
  });

  it('keeps a pinned session on the pin shelf, group or no group', () => {
    mount();
    makeGroup('Billing');
    dropOn(heading('Billing'), sessionDrag('p1', 'Adapter seam'));

    act(() => {
      useApp.setState({ pinnedSessions: ['p1:Adapter seam'] });
    });

    // Pinned outranks the group: a pin is "keep this in front of me", and a row
    // that answered to its group instead could be folded out of sight.
    expect(strip()).toEqual([
      'Pinned',
      'Adapter seam',
      'Billing',
      'api',
      'Token refresh',
      'SYSTEM-SERVER',
      'Served nightly',
      'web',
      'Login redirect',
    ]);
    // And the membership survives, so unpinning drops it back into Billing.
    expect(Object.keys(useApp.getState().sessionGroupOf)).toEqual(['p1:Adapter seam']);
  });

  it('does not touch the pin or the archive when a row is filed', () => {
    mount();
    makeGroup('Billing');
    act(() => {
      useApp.setState({ pinnedSessions: ['p1:Token refresh'] });
    });

    dropOn(heading('Billing'), sessionDrag('p1', 'Adapter seam'));

    // Filing is about where history lives, not about what the user is
    // watching. A drag that silently unpinned something would be an effect
    // nobody asked for on a gesture about something else.
    expect(useApp.getState().pinnedSessions).toEqual(['p1:Token refresh']);
    expect(useApp.getState().archivedSessions).toEqual([]);
  });

  it('still finds a grouped row through the filter', () => {
    // The field only appears once there is enough history to be worth typing
    // at, so this one seeds a sidebar past that threshold. The extra rows are
    // named out of the strip's alphabet deliberately: they are furniture for
    // the filter, not part of what is being read.
    act(() => {
      useApp.setState({
        sessions: [
          ...SESSIONS,
          ...Array.from({ length: 8 }, (_unused, index) =>
            session({ id: `Filler ${String(index)}`, cwd: '/code/web', updatedAt: index }),
          ),
        ],
      });
    });
    mount();
    makeGroup('Billing');
    dropOn(heading('Billing'), sessionDrag('p1', 'Adapter seam'));

    fireEvent.change(screen.getByLabelText('Filter sessions'), {
      target: { value: 'adapter' },
    });

    // The group's rows are filtered by the same query as everything else, and
    // the group that matches nothing goes with the unmatched projects.
    expect(strip()).toEqual(['Billing', 'Adapter seam']);
  });
});
