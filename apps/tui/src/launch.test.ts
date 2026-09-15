/**
 * What the first frame opens as.
 *
 * `launch()` is the seam between the flags, the remembered preferences and
 * the settings a conversation starts with. It reads a few small files —
 * accounts, what was last chosen, what was last typed — and spawns nothing,
 * so it can be driven against a temporary data directory holding one account.
 *
 * Every file it reads is under a temporary root here, the prompt history and
 * the snippets included: both are real files in a real state directory, and a
 * test that reached the developer's own would be reading their prompts and
 * could write over their templates.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { launch, type Launched } from './launch.js';

const PROFILE_ID = 'prof_work';

let root: string;
let dataDir: string;
let stateDir: string;
let cacheDir: string;
let cwd: string;
const opened: Launched[] = [];
/** Put back after the one test that sets it; the whole file runs in one process. */
const savedStateDirEnv = process.env['ARTEMIS_TUI_STATE_DIR'];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'artemis-launch-'));
  dataDir = join(root, 'data');
  stateDir = join(root, 'state');
  cacheDir = join(root, 'cache');
  cwd = join(root, 'work');
  await Promise.all([mkdir(dataDir, { recursive: true }), mkdir(stateDir, { recursive: true }), mkdir(cwd, { recursive: true })]);
  await writeFile(
    join(dataDir, 'profiles.json'),
    JSON.stringify({
      version: 2,
      profiles: [
        { id: PROFILE_ID, label: 'Work', providerId: 'claude', configDir: join(dataDir, 'profiles', 'work'), publicEnv: {}, createdAt: 1, updatedAt: 1 },
      ],
    }),
  );
});

afterEach(async () => {
  for (const launched of opened.splice(0)) await launched.host.dispose();
  if (savedStateDirEnv === undefined) delete process.env['ARTEMIS_TUI_STATE_DIR'];
  else process.env['ARTEMIS_TUI_STATE_DIR'] = savedStateDirEnv;
  await rm(root, { recursive: true, force: true });
});

async function open(extra: Record<string, unknown>): Promise<Launched> {
  const result = await launch({ dataDir, cwd, stateDir, cacheDir, profile: 'Work', ...extra });
  if (!result.ok) throw new Error(result.error);
  opened.push(result.launched);
  return result.launched;
}

async function remember(preferences: unknown): Promise<void> {
  await writeFile(join(stateDir, 'preferences.json'), JSON.stringify({ version: 1, preferences }));
}

/** A history file as a previous launch would have left it, in `dir`. */
async function typed(dir: string, ...texts: readonly string[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'history.jsonl'),
    texts.map((text, i) => `${JSON.stringify({ ts: i + 1, text, cwd })}\n`).join(''),
  );
}

/** A snippets file as somebody would have left it, in `dir`. */
async function saved(dir: string, ...snippets: readonly { readonly name: string; readonly body: string }[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'snippets.json'), JSON.stringify({ version: 1, snippets }));
}

describe('launch', () => {
  it('opens as the account it was last left as, when no account is named', async () => {
    // The order of preference the file describes, with the remembered
    // account first. Reaching the fallbacks would mean asking every account
    // for its conversations, which this test must not do.
    await remember({ profileId: PROFILE_ID });

    const result = await launch({ dataDir, cwd, stateDir, cacheDir });
    if (!result.ok) throw new Error(result.error);
    opened.push(result.launched);

    expect(result.launched.settings.profileId).toBe(PROFILE_ID);
  });

  it('restores the remembered permission mode only when the provider has it', async () => {
    await remember({ profileId: PROFILE_ID, permissionMode: 'plan' });
    expect((await open({})).settings.permissionMode).toBe('plan');

    // A mode the adapter would reject must not be handed to it; `default` is
    // the one every provider has.
    await remember({ profileId: PROFILE_ID, permissionMode: 'no-such-mode' });
    expect((await open({})).settings.permissionMode).toBe('default');
  });

  it('does not carry one model’s speed flags onto a different model named on the command line', async () => {
    // Fast mode belongs to the model it was chosen for. Remembered for model
    // `a`, it came along when `--model b` was given, and `b` may not even
    // have it.
    await remember({ profileId: PROFILE_ID, models: { [PROFILE_ID]: { model: 'a', fastMode: true, ultracode: true, effort: 'high' } } });

    const { settings } = await open({ model: 'b' });

    expect(settings.model).toBe('b');
    expect(settings.fastMode).toBeUndefined();
    expect(settings.ultracode).toBeUndefined();
    expect(settings.effort).toBeUndefined();
  });

  it('opens carrying what was typed before, read from the state directory it was given', async () => {
    await typed(stateDir, 'first prompt', 'second prompt');

    const { history } = await open({});

    // Newest first, which is the order the composer walks them in.
    expect(history.size).toBe(2);
    expect(history.recent({ kind: 'folder', cwd })).toEqual(['second prompt', 'first prompt']);
  });

  it('takes the history and the snippets from ARTEMIS_TUI_STATE_DIR when no state directory is named', async () => {
    // The override `tuiStateDir` honours has to move everything the state
    // directory holds along with the preferences, or a temporary state
    // directory is not temporary.
    const elsewhere = join(root, 'elsewhere');
    await typed(elsewhere, 'typed under the override');
    await saved(elsewhere, { name: 'under-the-override', body: 'saved elsewhere' });
    process.env['ARTEMIS_TUI_STATE_DIR'] = elsewhere;

    const result = await launch({ dataDir, cwd, cacheDir, profile: 'Work' });
    if (!result.ok) throw new Error(result.error);
    opened.push(result.launched);

    expect(result.launched.history.recent({ kind: 'all' })).toEqual(['typed under the override']);
    expect(result.launched.snippets.list().map((snippet) => snippet.name)).toEqual(['under-the-override']);
  });

  it('opens on an empty history when nothing has been typed here yet', async () => {
    expect((await open({})).history.size).toBe(0);
  });

  it('opens carrying the saved snippets, read from the state directory it was given', async () => {
    // Read at launch for the reason the history is: `;;` and `/snip` are
    // keystrokes, and neither is allowed to wait on a disk.
    await saved(stateDir, { name: 'review-diff', body: 'Review the diff against ${1:main}.' }, { name: 'explain', body: 'Explain @$1.' });

    const { snippets } = await open({});

    // Alphabetical, which is the order the menu and the file are in.
    expect(snippets.list().map((snippet) => snippet.name)).toEqual(['explain', 'review-diff']);
    expect(snippets.get('explain')?.body).toBe('Explain @$1.');
  });

  it('opens on no snippets when nothing has been saved, rather than failing', async () => {
    expect((await open({})).snippets.list()).toEqual([]);
  });
});
