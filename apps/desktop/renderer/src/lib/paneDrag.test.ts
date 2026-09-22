/**
 * @vitest-environment jsdom
 *
 * The contract between a caption that is picked up and the grid that takes the
 * drop.
 *
 * Two things are worth pinning. The pane drag must not answer for a session
 * drag or the other way round — a session dropped on a pane's centre opens in
 * it and a pane dropped there swaps with it, and every target tells them apart
 * by the type alone. And the ✕ in a caption must not be a handle, because a
 * drag that starts on it picks up the pane the user was trying to close.
 */

import { describe, expect, it } from 'vitest';

import { GROUP_DRAG_TYPE, isGroupDrag } from './groupDrag';
import {
  PANE_DRAG_TYPE,
  isPaneDrag,
  readPaneDrag,
  startsOnControl,
  writePaneDrag,
} from './paneDrag';
import { SESSION_DRAG_TYPE, isSessionDrag } from './sessionDrag';

/** As much of a `DataTransfer` as the contract touches. */
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

describe('a pane on a drag', () => {
  it('carries the pane id and nothing a text field would take', () => {
    const drag = transfer();

    writePaneDrag(drag, 'pane7');

    expect(isPaneDrag(drag)).toBe(true);
    expect(readPaneDrag(drag)).toBe('pane7');
    expect(drag.effectAllowed).toBe('move');
    // No `text/plain`: the dragged pane's own composer is not covered by a
    // target, and a text flavour would paste the pane's name into the prompt.
    expect(drag.types).toEqual([PANE_DRAG_TYPE]);
  });

  it('is neither a session nor a group, and neither of those is a pane', () => {
    const pane = transfer();
    writePaneDrag(pane, 'pane1');
    expect(isSessionDrag(pane)).toBe(false);
    expect(isGroupDrag(pane)).toBe(false);

    const session = transfer();
    session.setData(SESSION_DRAG_TYPE, '{}');
    const group = transfer();
    group.setData(GROUP_DRAG_TYPE, 'grp-1');
    expect(isPaneDrag(session)).toBe(false);
    expect(isPaneDrag(group)).toBe(false);
  });

  it('declines a drag with no pane on it', () => {
    expect(isPaneDrag(null)).toBe(false);
    expect(readPaneDrag(null)).toBeNull();
    expect(readPaneDrag(transfer())).toBeNull();
  });
});

describe('where a caption drag may start', () => {
  function caption(): {
    handle: HTMLElement;
    title: HTMLElement;
    close: HTMLElement;
    icon: Element;
  } {
    const handle = document.createElement('div');
    handle.innerHTML = '<span>Wire the seam</span><button type="button"><svg></svg></button>';
    return {
      handle,
      title: handle.querySelector('span')!,
      close: handle.querySelector('button')!,
      icon: handle.querySelector('svg')!,
    };
  }

  it('starts anywhere on the bar that is not a control', () => {
    const { handle, title } = caption();

    expect(startsOnControl(title, handle)).toBe(false);
    expect(startsOnControl(handle, handle)).toBe(false);
  });

  it('does not start on the close button, or on the icon inside it', () => {
    const { handle, close, icon } = caption();

    expect(startsOnControl(close, handle)).toBe(true);
    // The press lands on the glyph far more often than on the button's padding.
    expect(startsOnControl(icon, handle)).toBe(true);
  });

  it('ignores a control outside the handle', () => {
    // A caption nested in something clickable must still be draggable.
    const outer = document.createElement('button');
    const { handle, title } = caption();
    outer.append(handle);

    expect(startsOnControl(title, handle)).toBe(false);
  });
});
