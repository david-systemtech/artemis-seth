/**
 * The seam between the driver and Chrome.
 *
 * Everything the driver does to the browser goes through these four
 * operations, which is what lets `driver.ts` be read — and, where it matters,
 * tested — without a browser underneath it. The implementation over `chrome.*`
 * is `../chromeHost.ts` and is deliberately the dullest file in the package:
 * every decision worth making is on the other side of this interface.
 *
 * The shape is narrow on purpose. There is no `listTabs`, no `focus`, no
 * `activate`: the driver cannot ask for a tab it did not open because there is
 * no method here that would answer.
 */

/** A CDP event from one of Artemis's tabs. */
export interface PageEvent {
  readonly tabId: number;
  readonly method: string;
  readonly params: unknown;
}

export interface PageHost {
  /** Open a tab. The only source of a tab id anywhere in this extension. */
  openTab(url: string): Promise<number>;
  closeTab(tabId: number): Promise<void>;
  /**
   * Put a tab in the Artemis group, making the group when `groupId` is null,
   * and give it its title and colour. Returns the group, or `null` when the
   * browser would not make one — a failure worth continuing through, because a
   * tab in no group still works and a refused verb helps nobody.
   */
  groupTab(tabId: number, groupId: number | null): Promise<number | null>;

  attach(tabId: number): Promise<void>;
  detach(tabId: number): Promise<void>;
  send(tabId: number, method: string, params?: Record<string, unknown>): Promise<unknown>;

  /** CDP events, already filtered to tabs this extension opened. */
  onEvent(listener: (event: PageEvent) => void): void;
  /** The debugger let go of a tab — the user dismissed the bar, or it closed. */
  onDetached(listener: (tabId: number) => void): void;
  /** A tab went away, whoever closed it. */
  onTabClosed(listener: (tabId: number) => void): void;
}
