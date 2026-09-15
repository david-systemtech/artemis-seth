/**
 * What the terminal opens as, remembered between launches.
 *
 * Choosing an account, a model and a permission mode is work, and doing it
 * again at every launch is the same work twice. So the last of each is
 * written down when it changes and read back at startup, and a flag on the
 * command line still wins: `--profile`, `--model` and `--mode` are what
 * someone says when they mean *this* launch, not from now on.
 *
 * Deliberately not in `cache.ts`, though the file looks much the same. That
 * one holds answers Artemis can go and ask for again — a model list, a plan
 * reading — and says losing it costs a slow launch; losing this costs the
 * user their settings, which is not the same promise. It therefore lives in
 * the platform's state directory rather than its cache directory, where a
 * cleaner sweeping caches will not take it.
 *
 * The model is remembered per account. A model id belongs to the provider
 * that named it, and restoring Claude's model onto a Codex account would
 * either be refused by the adapter or, worse, quietly accepted — so what is
 * stored is a small map keyed by profile, and an account that has never been
 * chosen for simply opens on its provider's default.
 *
 * Pinned conversations are remembered here too, as a list of session ids. They
 * are a judgement about a conversation rather than about an account, they
 * outlive the launch that made them by definition — a pin whose whole point is
 * "keep this at the top" and that is forgotten on exit is a worse feature than
 * none — and they are the user's own words about their own work, which is the
 * same promise the rest of this file makes and not the one `cache.ts` makes.
 *
 * One JSON file, rewritten whole, atomically, and unreadable-means-empty: a
 * launch is never something a preferences file gets to fail.
 */

import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface PreferencesDirInputs {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
}

/**
 * Where the terminal UI keeps what it remembers — or `ARTEMIS_TUI_STATE_DIR`,
 * resolved to an absolute path, when it is set.
 *
 *  - Windows: `%APPDATA%\Artemis\tui`.
 *  - macOS:   `~/Library/Application Support/Artemis/tui`.
 *  - else:    `$XDG_STATE_HOME/artemis/tui`, or `~/.local/state/artemis/tui`.
 */
export function tuiStateDir(inputs: PreferencesDirInputs = {}): string {
  const env = inputs.env ?? process.env;
  const platform = inputs.platform ?? process.platform;
  const home = inputs.home ?? homedir();

  const declared = env['ARTEMIS_TUI_STATE_DIR'];
  if (declared !== undefined && declared.length > 0) return resolve(declared);

  if (platform === 'win32') {
    const appData = env['APPDATA'];
    const base = appData !== undefined && appData.length > 0 ? appData : join(home, 'AppData', 'Roaming');
    return join(base, 'Artemis', 'tui');
  }
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Artemis', 'tui');
  const xdg = env['XDG_STATE_HOME'];
  return join(xdg !== undefined && xdg.length > 0 ? xdg : join(home, '.local', 'state'), 'artemis', 'tui');
}

/** What one account was last set to. */
export interface ModelChoice {
  readonly model?: string;
  readonly modelLabel?: string;
  readonly effort?: string;
  readonly fastMode?: boolean;
  readonly ultracode?: boolean;
}

export interface Preferences {
  /** The account the last conversation ran as. */
  readonly profileId?: string;
  /** Permission mode, which is a habit rather than a property of an account. */
  readonly permissionMode?: string;
  /** Model and its effort and speed, per account. See the file header. */
  readonly models?: Readonly<Record<string, ModelChoice>>;
  /**
   * Session ids the user has pinned, oldest pin first.
   *
   * Session ids and nothing else: a title is the provider's to change and a
   * path is the directory's, while the id is what the conversation *is*. Ids
   * of conversations that no longer exist are kept rather than pruned — this
   * file has no way to ask a provider what it still holds, and a list that
   * quietly drops what it cannot explain would unpin a conversation for the
   * duration of an account being logged out.
   */
  readonly pinned?: readonly string[];
}

const FILE_VERSION = 1;
const FILE_NAME = 'preferences.json';

/** Shared, so that "nothing pinned" is one array and the memo below holds. */
const NO_PINS: readonly string[] = [];

interface FileShape {
  readonly version: number;
  readonly preferences: Preferences;
}

export class PreferencesStore {
  readonly #dir: string;
  readonly #path: string;
  #value: Preferences = {};
  /** Writes are chained so two quick changes cannot race each other's rename. */
  #writing: Promise<void> = Promise.resolve();
  /** {@link pinnedSet}'s answer, and the array it was built from. */
  #pinned: ReadonlySet<string> | undefined;
  #pinnedFrom: readonly unknown[] | undefined;

  constructor(dir: string) {
    this.#dir = dir;
    this.#path = join(dir, FILE_NAME);
    try {
      const parsed = JSON.parse(readFileSync(this.#path, 'utf8')) as Partial<FileShape> | null;
      if (parsed !== null && parsed.version === FILE_VERSION && typeof parsed.preferences === 'object' && parsed.preferences !== null) {
        this.#value = parsed.preferences;
      }
    } catch {
      // Missing or unreadable: nothing remembered, which is a fine way to open.
    }
  }

  get(): Preferences {
    return this.#value;
  }

  /** What this account was last set to, or nothing if it has never been chosen for. */
  modelFor(profileId: string): ModelChoice | undefined {
    return this.#value.models?.[profileId];
  }

  /** Remember `patch`; the file catches up in the background. */
  save(patch: Preferences): void {
    this.#value = { ...this.#value, ...patch, models: { ...this.#value.models, ...patch.models } };
    const snapshot: FileShape = { version: FILE_VERSION, preferences: this.#value };
    this.#writing = this.#writing.then(() => this.#write(snapshot)).catch(() => undefined);
  }

  /** Remember one account's model, leaving every other account's alone. */
  saveModelFor(profileId: string, choice: ModelChoice): void {
    this.save({ models: { [profileId]: choice } });
  }

  /** Resolves once every `save` so far is on disk (or has given up). */
  flush(): Promise<void> {
    return this.#writing;
  }

  /* ---------------------------------------------------------------------- */
  /* Pins                                                                    */
  /* ---------------------------------------------------------------------- */

  /**
   * Every pinned session id, as a set.
   *
   * The rail asks this once per draw and then asks it of every row, so it is a
   * set rather than a list — and the set is built from the stored array only
   * when that array is a different array, which is what keeps a redraw of two
   * hundred rows from being two hundred linear scans. Keying the memo on the
   * array's identity rather than on a flag is what makes it impossible for a
   * {@link save} from anywhere to leave a stale answer behind.
   */
  pinnedSet(): ReadonlySet<string> {
    // A file edited by hand can hold anything at all under `pinned`, and the
    // rail drawing a conversation list is not the place to find that out.
    const stored: readonly unknown[] = Array.isArray(this.#value.pinned) ? this.#value.pinned : NO_PINS;
    if (this.#pinnedFrom !== stored || this.#pinned === undefined) {
      this.#pinnedFrom = stored;
      this.#pinned = new Set(stored.filter((id): id is string => typeof id === 'string'));
    }
    return this.#pinned;
  }

  isPinned(sessionId: string): boolean {
    return this.pinnedSet().has(sessionId);
  }

  /**
   * Pin an unpinned conversation, or unpin a pinned one; answers with what it
   * now is, since the caller has to say which happened.
   *
   * Newest pin last, so the list reads as the order they were made in. An
   * unpin of something that was never pinned is a pin, which is what a toggle
   * means and is also the only sane reading of an id this file has never seen.
   */
  togglePin(sessionId: string): boolean {
    const pinned = this.isPinned(sessionId);
    const next = pinned
      ? [...this.pinnedSet()].filter((id) => id !== sessionId)
      : [...this.pinnedSet(), sessionId];
    this.save({ pinned: next });
    return !pinned;
  }

  async #write(snapshot: FileShape): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    const temp = `${this.#path}.${String(process.pid)}.tmp`;
    await writeFile(temp, JSON.stringify(snapshot, null, 2), 'utf8');
    await rename(temp, this.#path);
  }
}
