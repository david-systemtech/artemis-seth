/**
 * Which tab belongs to which conversation, and nothing about any other tab.
 * ============================================================================
 *
 * The rule from issue #436 is that the extension may touch tabs it opened and
 * no others, and this is where that rule lives. Every tab id the extension ever
 * holds came from a `chrome.tabs.create` it made; the book is the only place
 * they are kept; and every verb resolves its tab through {@link TabBook.tabFor}
 * rather than through anything that could name a tab another way.
 *
 * There is no `chrome.tabs.query` in this package and no `tabs` permission in
 * the manifest, so the rule is not only enforced here — it is enforced by the
 * absence of any other way to learn a tab id. This file is what makes the rule
 * *readable*; the manifest is what makes it true.
 *
 * ## It survives the worker
 *
 * An MV3 service worker is stopped when it goes quiet, and a conversation's tab
 * is still open when it comes back. So the book serialises to a plain object in
 * `chrome.storage.local` — losing it would leave orphan tabs in a group nobody
 * owns, and the next `open` would make a second tab for a conversation that
 * already had one.
 */

/** The book as it sits in storage. */
export interface TabBookSnapshot {
  /** runKey → tab id. */
  readonly tabs: Readonly<Record<string, number>>;
  /** The Artemis tab group, if one has been made and is still alive. */
  readonly groupId: number | null;
}

/** One conversation's page, for the popup's list. */
export interface RunTab {
  readonly runKey: string;
  readonly tabId: number;
}

export class TabBook {
  readonly #byRun = new Map<string, number>();
  #groupId: number | null = null;

  static fromSnapshot(snapshot: TabBookSnapshot | undefined): TabBook {
    const book = new TabBook();
    for (const [runKey, tabId] of Object.entries(snapshot?.tabs ?? {})) {
      if (typeof tabId === 'number' && Number.isInteger(tabId)) book.#byRun.set(runKey, tabId);
    }
    book.#groupId = typeof snapshot?.groupId === 'number' ? snapshot.groupId : null;
    return book;
  }

  toSnapshot(): TabBookSnapshot {
    return { tabs: Object.fromEntries(this.#byRun), groupId: this.#groupId };
  }

  get groupId(): number | null {
    return this.#groupId;
  }

  set groupId(id: number | null) {
    this.#groupId = id;
  }

  get size(): number {
    return this.#byRun.size;
  }

  /** The tab this conversation drives, or `null` if it has none yet. */
  tabFor(runKey: string): number | null {
    return this.#byRun.get(runKey) ?? null;
  }

  /** Whether this is one of Artemis's tabs. The gate on every debugger event. */
  owns(tabId: number): boolean {
    for (const id of this.#byRun.values()) if (id === tabId) return true;
    return false;
  }

  remember(runKey: string, tabId: number): void {
    this.#byRun.set(runKey, tabId);
  }

  /** Drop a conversation's page, returning the tab id that was its. */
  forgetRun(runKey: string): number | null {
    const tabId = this.#byRun.get(runKey) ?? null;
    this.#byRun.delete(runKey);
    return tabId;
  }

  /**
   * Drop a tab the user closed themselves, returning the run it belonged to.
   *
   * Called from `chrome.tabs.onRemoved`, which fires for every tab in the
   * browser — including the user's own, which this extension knows nothing
   * about. An id that is not in the book is not ours and the answer is `null`.
   */
  forgetTab(tabId: number): string | null {
    for (const [runKey, id] of this.#byRun) {
      if (id === tabId) {
        this.#byRun.delete(runKey);
        return runKey;
      }
    }
    return null;
  }

  /** Every conversation with a page open. */
  entries(): readonly RunTab[] {
    return [...this.#byRun].map(([runKey, tabId]) => ({ runKey, tabId }));
  }

  /** Every tab Artemis holds, for closing all of them at once. */
  allTabs(): readonly number[] {
    return [...this.#byRun.values()];
  }

  clear(): readonly number[] {
    const tabs = this.allTabs();
    this.#byRun.clear();
    this.#groupId = null;
    return tabs;
  }
}
