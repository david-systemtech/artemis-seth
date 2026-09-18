/**
 * The external editor's contract: which command line becomes which argv, what
 * the editor is handed, what comes back from it, and that the temporary
 * directory is gone whichever way the edit ended.
 *
 * The editor is a fake that writes into the file it was given, so no terminal
 * is taken over, nothing is spawned, and the suite passes on a machine with no
 * `$EDITOR` at all.
 */

import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { editInExternalEditor, splitCommand, type SpawnLike, type SpawnOptionsLike } from './externalEditor.js';

interface SpawnCall {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: SpawnOptionsLike;
}

/** What the editor did: saved something, refused, or never started. */
interface Behaviour {
  readonly save?: string;
  readonly code?: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly error?: Error;
}

/**
 * A fake editor. It is handed the argv a real one would be, writes what a
 * person might have saved, and exits on a later tick — the module registers its
 * listeners after the spawn call returns, as it would for a real child.
 */
function fakeEditor(behaviour: Behaviour | ((call: SpawnCall) => Behaviour)): { readonly calls: SpawnCall[]; readonly spawn: SpawnLike } {
  const calls: SpawnCall[] = [];
  const spawn: SpawnLike = (file, args, options) => {
    const call: SpawnCall = { file, args, options };
    calls.push(call);
    const acted = typeof behaviour === 'function' ? behaviour(call) : behaviour;
    const child = new EventEmitter();
    setTimeout(() => {
      void (async () => {
        if (acted.error !== undefined) {
          child.emit('error', acted.error);
          return;
        }
        const path = args.at(-1);
        if (acted.save !== undefined && path !== undefined) await writeFile(path, acted.save, 'utf8');
        child.emit('exit', acted.code === undefined ? 0 : acted.code, acted.signal ?? null);
      })();
    }, 0);
    return child;
  };
  return { calls, spawn };
}

let temp: string;
beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), 'artemis-edit-test-'));
});

const inTemp = (): string => temp;

describe('splitCommand', () => {
  it('splits on whitespace', () => {
    expect(splitCommand('code --wait')).toEqual(['code', '--wait']);
    expect(splitCommand('  vim   -f  ')).toEqual(['vim', '-f']);
    expect(splitCommand('nano')).toEqual(['nano']);
    expect(splitCommand('')).toEqual([]);
  });

  it('keeps a quoted Windows path whole, backslashes and all', () => {
    expect(splitCommand('"C:\\Program Files\\Sublime Text\\subl.exe" -w')).toEqual(['C:\\Program Files\\Sublime Text\\subl.exe', '-w']);
  });

  it('honours single quotes, quotes inside a word, and an unterminated quote', () => {
    expect(splitCommand("'/opt/my editor/ed' --wait")).toEqual(['/opt/my editor/ed', '--wait']);
    expect(splitCommand('ed --flag="a b" x')).toEqual(['ed', '--flag=a b', 'x']);
    expect(splitCommand('ed "unfinished text')).toEqual(['ed', 'unfinished text']);
    expect(splitCommand('ed ""')).toEqual(['ed', '']);
  });
});

describe('editInExternalEditor', () => {
  it('says so when neither variable is set, and treats a blank one as unset', async () => {
    expect(await editInExternalEditor('draft', { env: {}, tmpdir: inTemp })).toEqual({ ok: false, reason: 'neither VISUAL nor EDITOR is set' });
    expect(await editInExternalEditor('draft', { env: { VISUAL: '', EDITOR: '   ' }, tmpdir: inTemp })).toEqual({
      ok: false,
      reason: 'neither VISUAL nor EDITOR is set',
    });
  });

  it('prefers VISUAL, splits its arguments, and puts the file last with the terminal inherited', async () => {
    const editor = fakeEditor({ save: 'edited' });

    const result = await editInExternalEditor('draft', { env: { VISUAL: 'code --wait', EDITOR: 'vi' }, spawn: editor.spawn, tmpdir: inTemp });

    const call = editor.calls[0];
    expect(call?.file).toBe('code');
    expect(call?.args.slice(0, -1)).toEqual(['--wait']);
    expect(call?.options).toEqual({ stdio: 'inherit' });
    expect(result).toEqual({ ok: true, text: 'edited' });
  });

  it('falls back to EDITOR', async () => {
    const editor = fakeEditor({ save: 'from vi' });
    const result = await editInExternalEditor('draft', { env: { EDITOR: 'vi' }, spawn: editor.spawn, tmpdir: inTemp });

    expect(editor.calls[0]?.file).toBe('vi');
    expect(result).toEqual({ ok: true, text: 'from vi' });
  });

  it('opens a .md file in a fresh private directory, holding the draft it was given', async () => {
    let contents: string | undefined;
    const editor = fakeEditor((call) => {
      contents = readFileSync(call.args.at(-1) ?? '', 'utf8');
      return { save: 'edited' };
    });

    await editInExternalEditor('the first draft', { env: { EDITOR: 'vi' }, spawn: editor.spawn, tmpdir: inTemp });

    const path = editor.calls[0]?.args.at(-1) ?? '';
    expect(basename(path)).toBe('message.md');
    expect(dirname(dirname(path))).toBe(temp);
    expect(basename(dirname(path)).startsWith('artemis-edit-')).toBe(true);
    // Written before the editor ran, or the editor would have opened an empty file.
    expect(contents).toBe('the first draft');
  });

  it('strips exactly one trailing newline, CRLF included', async () => {
    const cases: readonly (readonly [string, string])[] = [
      ['hello\n', 'hello'],
      ['hello\n\n', 'hello\n'],
      ['hello\r\n', 'hello'],
      ['hello', 'hello'],
      ['', ''],
    ];
    for (const [saved, expected] of cases) {
      const editor = fakeEditor({ save: saved });
      const result = await editInExternalEditor('draft', { env: { EDITOR: 'vi' }, spawn: editor.spawn, tmpdir: inTemp });
      expect(result).toEqual({ ok: true, text: expected });
    }
  });

  it('treats a non-zero exit as an abandoned draft, leaving what was typed unread', async () => {
    const editor = fakeEditor({ save: 'typed, then abandoned with :cq', code: 1 });

    const result = await editInExternalEditor('draft', { env: { EDITOR: 'vim' }, spawn: editor.spawn, tmpdir: inTemp });

    expect(result).toEqual({ ok: false, reason: 'editor exited with status 1' });
  });

  it('reports the status it was given', async () => {
    const editor = fakeEditor({ code: 127 });
    const result = await editInExternalEditor('draft', { env: { EDITOR: 'vim' }, spawn: editor.spawn, tmpdir: inTemp });
    expect(result).toEqual({ ok: false, reason: 'editor exited with status 127' });
  });

  it('reports an editor that was killed rather than one that exited', async () => {
    const editor = fakeEditor({ code: null, signal: 'SIGKILL' });
    const result = await editInExternalEditor('draft', { env: { EDITOR: 'vim' }, spawn: editor.spawn, tmpdir: inTemp });
    expect(result).toEqual({ ok: false, reason: 'editor was stopped by SIGKILL' });
  });

  it('reports an editor that is not installed', async () => {
    const editor = fakeEditor({ error: Object.assign(new Error('spawn nvim ENOENT'), { code: 'ENOENT' }) });
    const result = await editInExternalEditor('draft', { env: { EDITOR: 'nvim' }, spawn: editor.spawn, tmpdir: inTemp });
    expect(result).toEqual({ ok: false, reason: 'could not run nvim: spawn nvim ENOENT' });
  });

  it('survives a spawn that throws on the spot', async () => {
    const spawn: SpawnLike = () => {
      throw new Error('EINVAL');
    };
    const result = await editInExternalEditor('draft', { env: { EDITOR: 'vi' }, spawn, tmpdir: inTemp });
    expect(result).toEqual({ ok: false, reason: 'could not run vi: EINVAL' });
  });

  it('explains a temp directory it could not make, rather than throwing', async () => {
    const editor = fakeEditor({ save: 'edited' });
    const result = await editInExternalEditor('draft', { env: { EDITOR: 'vi' }, spawn: editor.spawn, tmpdir: () => join(temp, 'nowhere') });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/could not make a temporary directory/);
    expect(editor.calls).toEqual([]);
  });

  it('removes its directory whether the edit was taken, abandoned or never started', async () => {
    const saved = fakeEditor({ save: 'kept' });
    await editInExternalEditor('draft', { env: { EDITOR: 'vi' }, spawn: saved.spawn, tmpdir: inTemp });
    const abandoned = fakeEditor({ save: 'gone', code: 1 });
    await editInExternalEditor('draft', { env: { EDITOR: 'vi' }, spawn: abandoned.spawn, tmpdir: inTemp });
    const missing = fakeEditor({ error: new Error('spawn vi ENOENT') });
    await editInExternalEditor('draft', { env: { EDITOR: 'vi' }, spawn: missing.spawn, tmpdir: inTemp });

    expect(await readdir(temp)).toEqual([]);
  });
});
