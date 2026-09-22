/**
 * @vitest-environment jsdom
 *
 * Dragging a pane by its caption, through a rendered window.
 * ============================================================================
 *
 * `paneGrid.test.ts` holds the grid to what a drop *does*; this holds the
 * working area to getting the drop there. The parts that can break without the
 * store noticing are all here: the caption is a handle and the ✕ in it is not,
 * the targets appear on every pane but the one in hand, a target that would
 * change nothing is not offered, and the overlay goes away when the drag ends.
 *
 * jsdom has no `DragEvent` and no real drag, so these fire the events a
 * browser would and hand each one a stand-in `DataTransfer`. What they cannot
 * show is the drag image or the cursor; those were not exercised here.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';

import { TooltipProvider } from '@/components/ui/tooltip';
import { WorkingArea } from '@/components/WorkingArea';
import { allPanes, closePane, focusedPane, paneCount, splitPane, useApp } from '../state/store';

/* Radix's floating layer needs observers jsdom does not implement. */
class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', NoopObserver);
vi.stubGlobal('DOMRectReadOnly', class {});
Element.prototype.scrollIntoView ??= function scrollIntoView(): void {};

/* The rendered window asks after live runs and sessions; nothing here cares. */
(globalThis.window as unknown as { artemis: unknown }).artemis = {
  runs: {
    list: async () => ({ ok: true, value: { runs: [] } }),
    liveWork: async () => ({ ok: true, value: { sessionIds: [], working: [], delegated: [] } }),
    onEvent: () => () => undefined,
  },
  sessions: {
    listAll: async () => ({ ok: true, value: { sessions: [], hasMore: false } }),
    messages: async () => ({ ok: true, value: { events: [], hasMore: false } }),
  },
};

/** As much of a `DataTransfer` as a drag between two elements touches. */
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
    dropEffect: 'none',
  } as unknown as DataTransfer;
}

const shape = (): string[][] => useApp.getState().grid.map((row) => row.panes.map((p) => p.id));

function collapse(): void {
  for (let guard = 0; guard < 20 && paneCount() > 1; guard += 1) {
    const last = allPanes()[paneCount() - 1];
    if (last) closePane(last.id);
  }
}

function renderWindow(): HTMLElement {
  return render(
    <TooltipProvider>
      <WorkingArea />
    </TooltipProvider>,
  ).container;
}

/** Each pane's card, in reading order. */
const cards = (root: HTMLElement): HTMLElement[] => [
  ...root.querySelectorAll<HTMLElement>('section[aria-label="Conversation"]'),
];

/** The bar at the top of a card: the handle. */
const captionOf = (card: HTMLElement): HTMLElement => card.firstElementChild as HTMLElement;

/** The drop targets drawn over a card, by zone. */
function zonesOver(card: HTMLElement): Map<string, HTMLElement> {
  const cell = card.parentElement as HTMLElement;
  return new Map(
    [...cell.querySelectorAll<HTMLElement>('[data-drop-zone]')].map((el) => [
      el.dataset['dropZone'] as string,
      el,
    ]),
  );
}

/** Pick a caption up, and let the overlay mount — it waits a tick on purpose. */
async function pickUp(caption: HTMLElement, from: Element = caption): Promise<DataTransfer> {
  const data = transfer();
  fireEvent.pointerDown(from);
  fireEvent.dragStart(caption, { dataTransfer: data });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return data;
}

beforeEach(() => {
  cleanup();
  collapse();
  useApp.setState({ background: [], banners: [], paneLayout: {}, booted: true });
});

describe('dragging a pane by its caption', () => {
  it('makes the caption the handle', () => {
    splitPane('right');
    const root = renderWindow();

    for (const card of cards(root)) expect(captionOf(card).getAttribute('draggable')).toBe('true');
  });

  it('offers targets on every pane but the one in hand', async () => {
    const left = focusedPane().id;
    splitPane('right');
    const root = renderWindow();
    const [first, second] = cards(root);

    await pickUp(captionOf(first!));

    expect(zonesOver(first!).size).toBe(0);
    // `left` is missing on purpose: the carried pane is already there.
    expect([...zonesOver(second!).keys()].sort()).toEqual(['centre', 'down', 'right', 'up']);
    expect(shape()[0]![0]).toBe(left);
  });

  it('moves the pane to the edge it is dropped on', async () => {
    const a = focusedPane().id;
    const b = splitPane('right')!.id;
    const root = renderWindow();
    const [first, second] = cards(root);

    const data = await pickUp(captionOf(first!));
    const below = zonesOver(second!).get('down')!;
    fireEvent.dragOver(below, { dataTransfer: data });
    fireEvent.drop(below, { dataTransfer: data });

    expect(shape()).toEqual([[b], [a]]);
    // And the overlay is gone with the drag.
    for (const card of cards(root)) expect(zonesOver(card).size).toBe(0);
  });

  it('swaps two panes when dropped on the centre', async () => {
    const a = focusedPane().id;
    const b = splitPane('right')!.id;
    const root = renderWindow();
    const [first, second] = cards(root);

    const data = await pickUp(captionOf(second!));
    const centre = zonesOver(first!).get('centre')!;
    fireEvent.dragOver(centre, { dataTransfer: data });
    fireEvent.drop(centre, { dataTransfer: data });

    expect(shape()).toEqual([[b, a]]);
  });

  it('lights up and names the target under the pointer', async () => {
    splitPane('right');
    const root = renderWindow();
    const [first, second] = cards(root);

    const data = await pickUp(captionOf(first!));
    const centre = zonesOver(second!).get('centre')!;
    fireEvent.dragOver(centre, { dataTransfer: data });

    expect(centre.className).toContain('bg-beam/15');
    expect(centre.textContent).toBe('Swap with this pane');
  });

  it('does not pick the pane up from its close button', () => {
    splitPane('right');
    const root = renderWindow();
    const caption = captionOf(cards(root)[0]!);
    const close = caption.querySelector('button')!;

    fireEvent.pointerDown(close);
    const started = fireEvent.dragStart(caption, { dataTransfer: transfer() });

    // `fireEvent` reports `false` when the handler cancelled the event, which is
    // what stops the browser from starting the drag.
    expect(started).toBe(false);
  });

  it('still closes the pane from its close button', () => {
    splitPane('right');
    const root = renderWindow();
    const close = captionOf(cards(root)[1]!).querySelector('button')!;

    fireEvent.pointerDown(close);
    fireEvent.click(close);

    expect(paneCount()).toBe(1);
  });

  it('still focuses the pane on a plain click of its caption', () => {
    const a = focusedPane().id;
    splitPane('right');
    const root = renderWindow();
    expect(focusedPane().id).not.toBe(a);

    const title = captionOf(cards(root)[0]!).querySelector('span')!;
    fireEvent.pointerDown(title);
    fireEvent.click(title);

    expect(focusedPane().id).toBe(a);
  });

  it('clears the targets when the drag ends without a drop', async () => {
    splitPane('right');
    const root = renderWindow();
    const [first, second] = cards(root);
    const before = shape();

    await pickUp(captionOf(first!));
    expect(zonesOver(second!).size).toBeGreaterThan(0);
    fireEvent.dragEnd(captionOf(first!));

    expect(zonesOver(second!).size).toBe(0);
    expect(shape()).toEqual(before);
  });
});
