/**
 * The list of skill repositories a headless host keeps, on disk.
 * ============================================================================
 *
 * The desktop keeps its sources in `<data dir>/skills.json`, beside the
 * always-on list, behind a store of its own that speaks the settings pane's
 * errors. A server needs the same file and none of that: no pane, no always-on
 * list of its own (a served run is told the *caller's*, by name, on the
 * request), and one writer. This is that store — the same document, parsed by
 * the same function, so a data directory moved between the two reads the same.
 *
 * Reads never throw: a run must not fail to start over a settings file, and a
 * document that cannot be parsed is a machine with no sources, which is where
 * every machine starts. Writes are serialised through one chain and land by
 * rename, so two administrators adding a repository at once both keep theirs
 * and a crash mid-write leaves the old file whole.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  parseSkillLibraryDocument,
  type SkillLibraryDocument,
  type SkillSource,
} from '@rx-artemis/protocol';

const EMPTY: SkillLibraryDocument = { version: 1, alwaysOn: [] };

export interface SkillSourceRegistry {
  /** The sources, in the order they were added. Empty for a file that is absent or unreadable. */
  sources(): Promise<readonly SkillSource[]>;
  /**
   * Change the document and store it. `change` is handed what is on disk *at
   * its turn*, never a copy read earlier, so concurrent changes compose.
   *
   * @throws when the file cannot be written — the one failure a caller asked
   * to hear about, because it means the change they made did not happen.
   */
  update(change: (current: SkillLibraryDocument) => SkillLibraryDocument): Promise<SkillLibraryDocument>;
}

export function createSkillSourceRegistry(file: string): SkillSourceRegistry {
  let tail: Promise<unknown> = Promise.resolve();

  const read = async (): Promise<SkillLibraryDocument> => {
    const raw = await readFile(file, 'utf8').catch(() => null);
    if (raw === null) return EMPTY;
    try {
      return parseSkillLibraryDocument(JSON.parse(raw) as unknown);
    } catch {
      return EMPTY;
    }
  };

  const write = async (document: SkillLibraryDocument): Promise<void> => {
    await mkdir(dirname(file), { recursive: true });
    // A sibling, so the rename stays on one filesystem and is atomic.
    const scratch = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(scratch, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
      await rename(scratch, file);
    } catch (error) {
      await unlink(scratch).catch(() => undefined);
      throw error;
    }
  };

  return {
    sources: async () => (await read()).sources ?? [],
    update: (change) => {
      const next = tail.then(async () => {
        const document = change(await read());
        await write(document);
        return document;
      });
      // The chain survives a failed write; the caller still hears about theirs.
      tail = next.catch(() => undefined);
      return next;
    },
  };
}
