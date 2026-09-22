/**
 * Dragging a pane by its caption, to rearrange the grid.
 * ============================================================================
 *
 * The third drag in the window, after a session row (`sessionDrag.ts`) and a
 * group heading (`groupDrag.ts`), and the contract between the same two kinds
 * of end: the caption knows how to *pick up* a pane and the working area knows
 * how to *recognise* one.
 *
 * ## Why a type of its own
 *
 * For the reason `groupDrag.ts` gives: a drop target can only ask what types a
 * drag carries until the drop itself, and a pane and a session held over the
 * same pane mean different things. A session dropped on a pane's centre opens
 * *in* it; a pane dropped there trades places with it. Every target has to tell
 * the two apart before it lights up, so the difference has to be in the type.
 *
 * ## No `text/plain`
 *
 * Unlike the other two. A session's title is a useful thing to drop into a note;
 * a pane is a place on this window's screen and means nothing anywhere else. And
 * the one text field a caption drag is most likely to cross is the dragged
 * pane's own composer, which is the one pane the drop targets do not cover — a
 * `text/plain` flavour would paste the conversation's name into the prompt.
 *
 * ## The payload is the pane id
 *
 * Pane ids are minted per window and never reused, so a drop from a pane that
 * closed mid-drag names nothing in the grid and moves nothing.
 */

import type { PaneId } from '../state/pane';

/** The drag type the working area listens for. Lower-case: see `sessionDrag.ts`. */
export const PANE_DRAG_TYPE = 'application/x-artemis-pane';

/** Put a pane on a drag. Call from `dragstart`. */
export function writePaneDrag(transfer: DataTransfer, paneId: PaneId): void {
  transfer.setData(PANE_DRAG_TYPE, paneId);
  // The pane goes somewhere else in the grid; it does not leave a copy behind.
  transfer.effectAllowed = 'move';
}

/**
 * Is this drag carrying a pane?
 *
 * Safe to call during `dragover`. `types` is walked rather than probed, for the
 * reason `isSessionDrag` gives.
 */
export function isPaneDrag(transfer: DataTransfer | null): boolean {
  if (!transfer) return false;
  for (const type of Array.from(transfer.types)) {
    if (type === PANE_DRAG_TYPE) return true;
  }
  return false;
}

/** Read the pane id back. Valid inside `dragstart` and `drop` only. */
export function readPaneDrag(transfer: DataTransfer | null): PaneId | null {
  if (!transfer) return null;
  const id = transfer.getData(PANE_DRAG_TYPE);
  return id.length === 0 ? null : id;
}

/**
 * Did this press land on a control inside the caption?
 *
 * The whole caption is the handle, but the ✕ in it is a button, and a drag that
 * began on a button would pick the pane up when the user was reaching for the
 * close. `dragstart` cannot answer this itself — its target is the draggable
 * element, not whatever was under the pointer — so the caption asks on
 * `pointerdown` and remembers.
 */
export function startsOnControl(target: EventTarget | null, handle: Element): boolean {
  if (!(target instanceof Element)) return false;
  const control = target.closest(
    'button, a, input, select, textarea, [role="button"], [role="menuitem"]',
  );
  return control !== null && control !== handle && handle.contains(control);
}
