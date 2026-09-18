/**
 * The contract between a group heading that is picked up and the list that
 * takes the drop.
 *
 * What is worth pinning is the one thing the two drags in the sidebar must never
 * do: answer for each other. A session held over a heading files into it and a
 * group held over the same heading lands beside it, and every target tells them
 * apart by the type alone — the payload is unreadable until the drop.
 */

import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '@rx-artemis/protocol';

import { GROUP_DRAG_TYPE, isGroupDrag, readGroupDrag, writeGroupDrag } from './groupDrag';
import { SESSION_DRAG_TYPE, isSessionDrag, readSessionDrag, writeSessionDrag } from './sessionDrag';

/** As much of a `DataTransfer` as either contract touches. */
function transfer(): DataTransfer {
  const data = new Map<string, string>();
  return {
    get types() {
      return [...data.keys()];
    },
    setData: (type: string, value: string) => {
      data.set(type, value);
    },
    getData: (type: string) => data.get(type) ?? '',
    effectAllowed: 'uninitialized',
  } as unknown as DataTransfer;
}

describe('a group on a drag', () => {
  it('carries the id for the list and the name for anywhere else', () => {
    const drag = transfer();

    writeGroupDrag(drag, { id: 'grp-1', name: 'Billing' });

    expect(isGroupDrag(drag)).toBe(true);
    expect(readGroupDrag(drag)).toBe('grp-1');
    expect(drag.getData('text/plain')).toBe('Billing');
    // The heading goes somewhere else; it does not leave a copy behind.
    expect(drag.effectAllowed).toBe('move');
  });

  it('is not a session, and a session is not a group', () => {
    // The group type deliberately starts with the session type's spelling, so
    // this is the assertion that both are compared whole: a group that read as
    // a session would open a split when dragged over the working area.
    expect(GROUP_DRAG_TYPE.startsWith(SESSION_DRAG_TYPE)).toBe(true);

    const group = transfer();
    writeGroupDrag(group, { id: 'grp-1', name: 'Billing' });
    expect(isSessionDrag(group)).toBe(false);
    expect(readSessionDrag(group)).toBeNull();

    const row = transfer();
    writeSessionDrag(row, { id: 's1', profileId: 'p1', title: 'Adapter seam' } as SessionSummary);
    expect(isGroupDrag(row)).toBe(false);
    expect(readGroupDrag(row)).toBeNull();
  });

  it('declines a drag from anywhere else, and no drag at all', () => {
    const foreign = transfer();
    foreign.setData('text/plain', 'https://example.com');

    expect(isGroupDrag(foreign)).toBe(false);
    expect(readGroupDrag(foreign)).toBeNull();
    expect(isGroupDrag(null)).toBe(false);
    expect(readGroupDrag(null)).toBeNull();
  });
});
