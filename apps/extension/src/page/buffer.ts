/**
 * What the page said while nobody was asking.
 *
 * `console()` and `network()` are "since the last call", so something has to
 * hold the lines between calls. A page left open on a site with a polling
 * request produces those lines forever, and the worker holding them has a fixed
 * memory budget and is restarted when Chrome feels like it — so the buffer is
 * bounded, drops its oldest, and *says* that it did.
 *
 * Saying so is the part worth being careful about. A bounded buffer that
 * silently discards is worse than no buffer: an agent reading five hundred
 * requests and concluding "the login call was never made" is wrong in a way it
 * cannot detect. {@link BoundedLog.drain} therefore returns the count it threw
 * away, which the driver turns into the `notice` on the result.
 */

/** How many entries a page's console or network log keeps. */
export const BUFFER_LIMIT = 500;

/** Entries that survived, and how many did not. */
export interface Drained<T> {
  readonly entries: readonly T[];
  readonly dropped: number;
}

/** A serialised buffer, small enough to put in `chrome.storage.session`. */
export interface BufferSnapshot<T> {
  readonly entries: readonly T[];
  readonly dropped: number;
}

/**
 * A fixed-size log that keeps the newest.
 *
 * An array with a `shift` rather than a true ring: at five hundred entries the
 * copy is not measurable, and a ring's index arithmetic is the sort of thing
 * that is wrong for a month before anybody notices the oldest line is missing.
 */
export class BoundedLog<T> {
  #entries: T[] = [];
  #dropped = 0;

  constructor(private readonly limit: number = BUFFER_LIMIT) {}

  get size(): number {
    return this.#entries.length;
  }

  push(entry: T): void {
    this.#entries.push(entry);
    while (this.#entries.length > this.limit) {
      this.#entries.shift();
      this.#dropped += 1;
    }
  }

  /** Everything since the last drain, and the count lost to the ceiling. */
  drain(): Drained<T> {
    const entries = this.#entries;
    const dropped = this.#dropped;
    this.#entries = [];
    this.#dropped = 0;
    return { entries, dropped };
  }

  /** Read without consuming. For the popup, which shows a page's state. */
  peek(): readonly T[] {
    return this.#entries;
  }

  toSnapshot(): BufferSnapshot<T> {
    return { entries: [...this.#entries], dropped: this.#dropped };
  }

  static fromSnapshot<T>(snapshot: BufferSnapshot<T> | undefined, limit: number = BUFFER_LIMIT): BoundedLog<T> {
    const log = new BoundedLog<T>(limit);
    for (const entry of snapshot?.entries ?? []) log.push(entry);
    log.#dropped = snapshot?.dropped ?? 0;
    return log;
  }
}

/**
 * The sentence a drain's loss becomes on the result.
 *
 * One place, so the console and the network verbs say it the same way and a
 * test can assert on the wording an agent will read.
 */
export function droppedNotice(dropped: number, what: string): string | undefined {
  if (dropped <= 0) return undefined;
  return `${String(dropped)} older ${what} ${dropped === 1 ? 'entry was' : 'entries were'} dropped: this page's buffer holds ${String(BUFFER_LIMIT)}.`;
}
