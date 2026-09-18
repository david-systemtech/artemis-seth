/**
 * Finding a conversation's transcript when it is not where its directory says.
 *
 * The CLI files a conversation under `projects/<working directory, with every
 * non-alphanumeric turned into a dash>/<sessionId>.jsonl` — and leaves it
 * there. A conversation whose directory changes part-way, relocated or resumed
 * from somewhere else, goes on appending to the folder it was *begun* in while
 * every later run names the new directory.
 *
 * The lookup used to treat a directory, when it was given one, as the whole
 * answer: a miss there was final, and the search of the other folders ran only
 * when no directory was named at all. So the queued messages of such a
 * conversation — which exist *only* as `queued_command` rows in that file —
 * were read from nowhere, and vanished from the replayed history. These pin
 * the order: the run's own directory first, then the file by its id.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { findSessionTranscript } from '../claude.js';

const SESSION = '0c1d2e3f-0000-4000-8000-000000000001';

let configDir: string;

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'artemis-claude-lookup-'));
});

afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
});

/** File the conversation the way the CLI would for a run in `cwd`. */
async function fileUnder(cwd: string): Promise<string> {
  const folder = join(configDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  await mkdir(folder, { recursive: true });
  const file = join(folder, `${SESSION}.jsonl`);
  await writeFile(file, '{"type":"user"}\n', 'utf8');
  return file;
}

describe('findSessionTranscript', () => {
  it('finds the file under the directory the run names', async () => {
    const file = await fileUnder('/work/server');
    expect(await findSessionTranscript(configDir, '/work/server', SESSION)).toBe(file);
  });

  it('finds it where the conversation began, when the run names another directory', async () => {
    const file = await fileUnder('/work/server');
    expect(await findSessionTranscript(configDir, '/work/server/timekeepers', SESSION)).toBe(file);
  });

  it('prefers the run’s own directory when the id is filed in two', async () => {
    await fileUnder('/work/server');
    const own = await fileUnder('/work/server/timekeepers');
    expect(await findSessionTranscript(configDir, '/work/server/timekeepers', SESSION)).toBe(own);
  });

  it('finds it by its id alone when no directory is named', async () => {
    const file = await fileUnder('/work/server');
    expect(await findSessionTranscript(configDir, undefined, SESSION)).toBe(file);
  });

  it('says so when the conversation is filed nowhere', async () => {
    await fileUnder('/work/server');
    const other = '0c1d2e3f-0000-4000-8000-000000000002';
    expect(await findSessionTranscript(configDir, '/work/server', other)).toBeUndefined();
  });
});
