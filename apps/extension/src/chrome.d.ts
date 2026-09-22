/**
 * The extension APIs this extension uses, and no others.
 * ============================================================================
 *
 * `@types/chrome` describes every API Chrome has ever shipped, which is the
 * opposite of what is wanted here. The manifest asks for five permissions and
 * the README justifies each one; a type surface that also offers `history`,
 * `bookmarks` and `tabs.query` invites a future change to quietly use one and
 * makes the justification stale. What is declared below is the whole of the
 * extension platform as far as this package's compiler is concerned, so
 * reaching for anything else is a type error and an argument, not an accident.
 *
 * Two absences are deliberate and load-bearing:
 *
 *  - **No `chrome.tabs.query` and no `chrome.windows.getAll`.** The extension
 *    must never read a tab it did not open (issue #436). The only way it learns
 *    a tab id is {@link Tabs.create} returning one, so there is no code path
 *    that could enumerate the user's browsing even by mistake.
 *  - **No `chrome.scripting`.** Everything done to a page goes through
 *    `chrome.debugger`, attached only to Artemis's own tabs. A second route
 *    into page content would be a second place to enforce the policy.
 *
 * Every method is declared in its promise form. MV3 returns promises from the
 * extension APIs when no callback is passed, and callbacks here would mean
 * `chrome.runtime.lastError` checks at forty call sites.
 */

/** An `addListener`/`removeListener` pair, as every `chrome.*` event is. */
interface ChromeEvent<Listener extends (...args: never[]) => void> {
  addListener(listener: Listener): void;
  removeListener(listener: Listener): void;
}

/** Everything the service worker, options page and popup share. */
interface ChromeRuntime {
  /** The extension's own id. Stable across machines because of `key` in the manifest. */
  readonly id: string;
  /** Set when a callback-style call failed. Read after `sendMessage` to a closed port. */
  readonly lastError?: { readonly message?: string } | undefined;
  getManifest(): { readonly version: string; readonly name: string };
  getURL(path: string): string;
  /** Send to the service worker (from a page) or to every page (from the worker). */
  sendMessage(message: unknown): Promise<unknown>;
  readonly onMessage: ChromeEvent<
    (message: unknown, sender: unknown, respond: (response: unknown) => void) => boolean | void
  >;
  readonly onStartup: ChromeEvent<() => void>;
  readonly onInstalled: ChromeEvent<(details: { readonly reason: string }) => void>;
}

/** One `chrome.storage` area. */
interface ChromeStorageArea {
  get(keys: string | readonly string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | readonly string[]): Promise<void>;
}

interface ChromeStorage {
  /** Survives a browser restart. Pairing, the port, the policy, the audit log. */
  readonly local: ChromeStorageArea;
  /**
   * Survives a service-worker restart but not a browser restart, and is never
   * written to disk. Console and network buffers live here: losing them when
   * Chrome quits is correct, because the tabs they describe are gone too.
   */
  readonly session: ChromeStorageArea;
}

/** A tab, reduced to the three fields anything here reads. */
interface ChromeTab {
  readonly id?: number | undefined;
  readonly url?: string | undefined;
  readonly title?: string | undefined;
  readonly windowId?: number | undefined;
}

interface ChromeTabs {
  create(properties: { url?: string; active?: boolean; windowId?: number }): Promise<ChromeTab>;
  /** Only ever called with an id this extension was handed by `create`. */
  get(tabId: number): Promise<ChromeTab>;
  remove(tabIds: number | readonly number[]): Promise<void>;
  /** Put tabs in a group, making one when `groupId` is absent. Returns the group id. */
  group(options: { tabIds: number | readonly number[]; groupId?: number }): Promise<number>;
  readonly onRemoved: ChromeEvent<(tabId: number, info: { readonly windowId: number }) => void>;
}

/** The colours Chrome will accept for a tab group. */
type ChromeTabGroupColor = 'grey' | 'blue' | 'red' | 'yellow' | 'green' | 'pink' | 'purple' | 'cyan' | 'orange';

interface ChromeTabGroups {
  get(groupId: number): Promise<{ readonly id: number; readonly title?: string | undefined }>;
  update(groupId: number, properties: { title?: string; color?: ChromeTabGroupColor; collapsed?: boolean }): Promise<unknown>;
  readonly onRemoved: ChromeEvent<(group: { readonly id: number }) => void>;
}

/** Which tab a debugger command is for. Always a tab this extension opened. */
interface ChromeDebuggee {
  readonly tabId: number;
}

interface ChromeDebugger {
  attach(target: ChromeDebuggee, requiredVersion: string): Promise<void>;
  detach(target: ChromeDebuggee): Promise<void>;
  sendCommand(target: ChromeDebuggee, method: string, params?: Record<string, unknown>): Promise<unknown>;
  readonly onEvent: ChromeEvent<(source: ChromeDebuggee, method: string, params?: unknown) => void>;
  /** Fires when the user closes the "Artemis is debugging this browser" bar, too. */
  readonly onDetach: ChromeEvent<(source: ChromeDebuggee, reason: string) => void>;
}

interface ChromeAlarms {
  create(name: string, info: { periodInMinutes?: number; delayInMinutes?: number }): Promise<void>;
  clear(name: string): Promise<boolean>;
  readonly onAlarm: ChromeEvent<(alarm: { readonly name: string }) => void>;
}

/** The toolbar button. Used for the badge that says a run has tabs open. */
interface ChromeAction {
  setBadgeText(details: { text: string }): Promise<void>;
  setBadgeBackgroundColor(details: { color: string }): Promise<void>;
  setTitle(details: { title: string }): Promise<void>;
}

interface ChromeApi {
  readonly runtime: ChromeRuntime;
  readonly storage: ChromeStorage;
  readonly tabs: ChromeTabs;
  readonly tabGroups: ChromeTabGroups;
  readonly debugger: ChromeDebugger;
  readonly alarms: ChromeAlarms;
  readonly action: ChromeAction;
}

declare const chrome: ChromeApi;

/**
 * The user-agent hints the extension reads to name itself in Artemis settings.
 * `navigator.userAgentData` is Chromium-only and TypeScript's DOM library does
 * not describe it, so the two fields used are declared here rather than reached
 * for through a cast.
 */
interface NavigatorUABrandVersion {
  readonly brand: string;
  readonly version: string;
}

interface NavigatorUAData {
  readonly brands: readonly NavigatorUABrandVersion[];
  readonly platform: string;
}

interface Navigator {
  readonly userAgentData?: NavigatorUAData | undefined;
}

interface WorkerNavigator {
  readonly userAgentData?: NavigatorUAData | undefined;
}
