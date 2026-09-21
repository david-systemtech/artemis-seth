/**
 * {@link PageHost} over the real `chrome.*` APIs.
 *
 * The dullest file in the package, and that is the design: every decision worth
 * arguing about is on the other side of the interface, in `page/driver.ts`, and
 * what is left here is the shape of Chrome's API. When something in this file
 * is interesting, it is because Chrome made it so — the group that has to be
 * created by grouping a tab, the events that arrive for every tab in the
 * browser and have to be filtered down to Artemis's own.
 */

import { GROUP_COLOUR, GROUP_TITLE } from './manifest.js';
import type { PageEvent, PageHost } from './page/host.js';

/** CDP version. 1.3 is the stable one and the only one worth pinning to. */
const CDP_VERSION = '1.3';

export class ChromePageHost implements PageHost {
  /**
   * Tabs this host has opened, so the two browser-wide event streams can be
   * filtered before anything downstream sees them.
   *
   * A second copy of what `TabBook` holds, and worth it: `chrome.debugger.onEvent`
   * and `chrome.tabs.onRemoved` fire for tabs this extension has nothing to do
   * with, and filtering at the adapter means a bug in the driver cannot turn
   * into the extension reading somebody else's page. The book is the record;
   * this is the doorman.
   */
  readonly #mine = new Set<number>();

  async openTab(url: string): Promise<number> {
    // `active: false` so the agent's page does not steal the tab the user is
    // reading. The group makes it findable; taking focus would make it rude.
    const tab = await chrome.tabs.create({ url, active: false });
    if (tab.id === undefined) throw new Error('Chrome opened a tab without an id.');
    this.#mine.add(tab.id);
    return tab.id;
  }

  async closeTab(tabId: number): Promise<void> {
    this.#mine.delete(tabId);
    await chrome.tabs.remove(tabId);
  }

  /**
   * Put a tab in the Artemis group.
   *
   * Chrome has no "create a group" call — a group comes into existence by
   * grouping a tab into it — so this is the same call whether the group exists
   * or not, and the title and colour are applied afterwards. Grouping into a
   * `groupId` that no longer exists (the user closed the last tab in it) throws,
   * and the answer to that is to make a new one, which is what the retry does.
   */
  async groupTab(tabId: number, groupId: number | null): Promise<number | null> {
    const group = await this.#groupInto(tabId, groupId);
    if (group === null) return null;
    try {
      await chrome.tabGroups.update(group, { title: GROUP_TITLE, color: GROUP_COLOUR, collapsed: false });
    } catch {
      // A group that cannot be titled is still a group. The mark is weaker, the
      // tab is still Artemis's, and refusing the verb over it would be absurd.
    }
    return group;
  }

  async #groupInto(tabId: number, groupId: number | null): Promise<number | null> {
    if (groupId !== null) {
      try {
        return await chrome.tabs.group({ tabIds: [tabId], groupId });
      } catch {
        // The remembered group is gone. Fall through and make a fresh one.
      }
    }
    try {
      return await chrome.tabs.group({ tabIds: [tabId] });
    } catch {
      return null;
    }
  }

  async attach(tabId: number): Promise<void> {
    await chrome.debugger.attach({ tabId }, CDP_VERSION);
  }

  async detach(tabId: number): Promise<void> {
    await chrome.debugger.detach({ tabId });
  }

  async send(tabId: number, method: string, params?: Record<string, unknown>): Promise<unknown> {
    return chrome.debugger.sendCommand({ tabId }, method, params ?? {});
  }

  onEvent(listener: (event: PageEvent) => void): void {
    chrome.debugger.onEvent.addListener((source, method, params) => {
      if (source.tabId === undefined || !this.#mine.has(source.tabId)) return;
      listener({ tabId: source.tabId, method, params });
    });
  }

  onDetached(listener: (tabId: number) => void): void {
    chrome.debugger.onDetach.addListener((source) => {
      if (source.tabId !== undefined && this.#mine.has(source.tabId)) listener(source.tabId);
    });
  }

  onTabClosed(listener: (tabId: number) => void): void {
    chrome.tabs.onRemoved.addListener((tabId) => {
      if (!this.#mine.has(tabId)) return;
      this.#mine.delete(tabId);
      listener(tabId);
    });
  }

  /**
   * Take back the tab ids a stopped service worker was holding.
   *
   * The doorman's set is in memory and the worker is restarted at Chrome's
   * convenience, so on every start the ids come back from the book in
   * `chrome.storage.local`. Without this the first event after a restart would
   * be filtered out as somebody else's and the driver would never see it.
   */
  adopt(tabIds: Iterable<number>): void {
    for (const tabId of tabIds) this.#mine.add(tabId);
  }
}
