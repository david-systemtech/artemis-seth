/**
 * The always-on skill choices, from the main process's side.
 * ============================================================================
 *
 * `<userDataDir>/skills.json`, written the way `AgentPromptStore` writes
 * `agent-prompts.json` and for both of the reasons that file gives: it is a
 * choice the user made on purpose rather than a preference the platform may
 * evict, and it is read on the path of every run, which starts here in main.
 *
 * What is stored is small — a list of skill *names* and who each applies to.
 * The skills themselves are folders on disk, read fresh when they are listed
 * and again when a run composes them, so nothing in this file can go stale
 * except by naming a skill that is no longer there. That is kept on purpose;
 * see `SkillLibraryDocument` in the protocol.
 *
 * Rebuilt, never passed through: both the read and the write go through
 * {@link parseSkillLibraryDocument}, so a hand-edited file costs the one entry
 * that is broken rather than the library, and what lands on disk is what a read
 * would have produced.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  defaultSkillLibraryDocument,
  parseSkillLibraryDocument,
  type SkillLibraryDocument,
} from '@rx-artemis/protocol';

import { WorkspaceError } from './errors.js';
import { createLogger } from './log.js';

const log = createLogger('skills');

/** The document's filename under `userData`. */
export const SKILL_LIBRARY_FILE = 'skills.json';

export interface SkillLibraryStoreOptions {
  /** Absolute path to Electron's `userData`. */
  readonly userDataDir: string;
  /** Overridable for tests. */
  readonly fileName?: string;
}

/**
 * The choices on disk. One instance per process, for the reason
 * `AgentPromptStore` gives: the cache is what keeps a file read off the path of
 * every run, and two instances would each hold a copy the other's writes never
 * reach.
 */
export class SkillLibraryStore {
  readonly #file: string;
  readonly #userDataDir: string;
  #cache: SkillLibraryDocument | null = null;
  /** Serialises writes; the pane's switches can be thrown faster than a rename lands. */
  #tail: Promise<unknown> = Promise.resolve();

  constructor(options: SkillLibraryStoreOptions) {
    if (!options.userDataDir || !path.isAbsolute(options.userDataDir)) {
      throw new WorkspaceError(
        `userDataDir must be an absolute path, got ${JSON.stringify(options.userDataDir)}`,
      );
    }
    this.#userDataDir = path.resolve(options.userDataDir);
    this.#file = path.join(this.#userDataDir, options.fileName ?? SKILL_LIBRARY_FILE);
  }

  /** Absolute path of the document. */
  get file(): string {
    return this.#file;
  }

  /**
   * The choices, for a run. Never throws: an absent file is nothing on, and so
   * is one that cannot be read or parsed — a run that refused to start because
   * a settings document was corrupt would be Artemis failing at its actual job
   * over a feature the user may never have touched.
   *
   * But a guess is not remembered. Caching it would keep every later run on
   * "nothing on" after a lock that lifted a second later, and hand the pane a
   * guess to save over the real file; the next read tries the file again.
   */
  async read(): Promise<SkillLibraryDocument> {
    try {
      return await this.load();
    } catch (error) {
      log.warn(`${error instanceof Error ? error.message : String(error)}; composing no always-on skills`);
      return defaultSkillLibraryDocument();
    }
  }

  /**
   * The choices, for the pane that edits them — which, unlike a run, must not
   * be handed a guess: switches drawn over "nothing on" for a file that could
   * not be read would, on the first click, save that guess over it. Throws for
   * anything but an absent file, and the pane shows why instead of switches.
   */
  async load(): Promise<SkillLibraryDocument> {
    if (this.#cache) return this.#cache;

    let raw: string;
    try {
      raw = await readFile(this.#file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.#cache = defaultSkillLibraryDocument();
        return this.#cache;
      }
      throw new WorkspaceError(
        `Could not read ${this.#file}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new WorkspaceError(`${this.#file} is not valid JSON. Fix it, or delete it to start over.`);
    }
    this.#cache = parseSkillLibraryDocument(parsed);
    return this.#cache;
  }

  /** Replace the choices. Answers with what was actually stored. */
  async write(document: SkillLibraryDocument): Promise<SkillLibraryDocument> {
    const next = parseSkillLibraryDocument(document);
    const run = this.#tail.then(async () => {
      const body = `${JSON.stringify(next, null, 2)}\n`;
      const tmp = `${this.#file}.${randomUUID().slice(0, 8)}.tmp`;

      await mkdir(this.#userDataDir, { recursive: true, mode: 0o700 });
      await writeFile(tmp, body, { encoding: 'utf8', mode: 0o600 });
      try {
        await rename(tmp, this.#file);
      } catch (error) {
        await unlink(tmp).catch(() => undefined);
        throw new WorkspaceError(
          `Could not write ${this.#file}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      this.#cache = next;
      return next;
    });
    // Never left rejected: one transient disk error must not fail every save
    // after it.
    this.#tail = run.catch(() => undefined);
    return run;
  }
}
