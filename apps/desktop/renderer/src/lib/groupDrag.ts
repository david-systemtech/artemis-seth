/**
 * Dragging a group heading, to put the groups in a different order.
 * ============================================================================
 *
 * The sidebar's groups are drawn in the order they are stored, and that order
 * is the user's to arrange: pick a heading up, drop it between two others. This
 * module is the contract between the heading that is picked up and the list
 * that takes the drop — the same shape `sessionDrag.ts` gives a session row,
 * and for the same reasons.
 *
 * ## Why a second MIME type rather than a flag on the session one
 *
 * A drop target can only ask *what types* a drag carries until the drop itself
 * — the data store is in protected mode for `dragover` — so everything that has
 * to be decided mid-drag has to be decided from the type. And the two drags
 * mean opposite things to the same elements: a session held over a group
 * heading is about to be *filed into* it, a group held over the same heading is
 * about to be *placed beside* it, and the working area opens a split for the
 * first and must do nothing at all for the second. One type with a `kind` field
 * inside would make every one of those targets accept both and sort it out on
 * the drop, after it had already lit up for the wrong gesture.
 *
 * The type is compared whole, never by prefix: it deliberately starts with the
 * session type's spelling because it is the same family, and `isSessionDrag`
 * matching on equality is what keeps a group from opening a split.
 *
 * ## The payload is the id, not the group
 *
 * For the reason a session's payload is a key: the name on the heading can be
 * edited while a drag from another window is in flight, and the drop resolves
 * the id against the live list. An id the list no longer holds moves nothing.
 *
 * `text/plain` carries the name as well, for a drag that ends outside Artemis.
 */

/** The drag type the sidebar listens for. Lower-case: see `sessionDrag.ts`. */
export const GROUP_DRAG_TYPE = 'application/x-artemis-session-group';

/** Put a group on a drag. Call from `dragstart`. */
export function writeGroupDrag(
  transfer: DataTransfer,
  group: { readonly id: string; readonly name: string },
): void {
  transfer.setData(GROUP_DRAG_TYPE, group.id);
  // For drops outside Artemis. See the file header.
  transfer.setData('text/plain', group.name);
  // The heading goes somewhere else; it does not leave a copy behind.
  transfer.effectAllowed = 'move';
}

/**
 * Is this drag carrying a group?
 *
 * Safe to call during `dragover`. `types` is walked rather than probed, for the
 * reason `isSessionDrag` gives.
 */
export function isGroupDrag(transfer: DataTransfer | null): boolean {
  if (!transfer) return false;
  for (const type of Array.from(transfer.types)) {
    if (type === GROUP_DRAG_TYPE) return true;
  }
  return false;
}

/** Read the group id back. Only valid inside a `drop` handler. */
export function readGroupDrag(transfer: DataTransfer | null): string | null {
  if (!transfer) return null;
  const id = transfer.getData(GROUP_DRAG_TYPE);
  return id.length === 0 ? null : id;
}
