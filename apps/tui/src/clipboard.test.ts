/**
 * The clipboard's contract: which program is run on which platform, with which
 * arguments; what the exact bytes of an OSC 52 copy are, in tmux and out of it;
 * and that every way a clipboard can disappoint is `null` rather than a throw.
 *
 * Nothing here touches a real clipboard. The platform, the environment, the
 * process runner, the PATH lookup and the output stream are all injected, so
 * the macOS assertions run on a Linux CI box and the Windows ones on both.
 */

import { access, chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MAX_ATTACHMENT_BYTES } from './attachments.js';
import {
  CLIPBOARD_TIMEOUT_MS,
  clipboardBackend,
  copyText,
  onPath,
  osc52Sequence,
  readClipboardImage,
  readClipboardText,
  runClipboardTool,
  type ClipboardDeps,
  type ExecFileLike,
  type RunOptions,
} from './clipboard.js';

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

const READ_OPTIONS: RunOptions = { timeoutMs: CLIPBOARD_TIMEOUT_MS, maxBytes: MAX_ATTACHMENT_BYTES + 1 };

interface ExecCall {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: RunOptions;
}

type Answer = Uint8Array | string | Error;

/** A stand-in for running a program: records the argv, returns what it is told. */
function fakeExec(answer: (call: ExecCall) => Answer | Promise<Answer>): { readonly calls: ExecCall[]; readonly execFile: ExecFileLike } {
  const calls: ExecCall[] = [];
  const execFile: ExecFileLike = async (file, args, options) => {
    const call: ExecCall = { file, args, options };
    calls.push(call);
    const result = await answer(call);
    if (result instanceof Error) throw result;
    return { stdout: typeof result === 'string' ? new Uint8Array(Buffer.from(result, 'utf8')) : result };
  };
  return { calls, execFile };
}

const answering = (result: Answer): { readonly calls: ExecCall[]; readonly execFile: ExecFileLike } => fakeExec(() => result);

/** A PNG as far as anything here cares: the signature and some payload. */
function pngBytes(payload: number): Uint8Array {
  const bytes = new Uint8Array(8 + payload);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (let index = 0; index < payload; index += 1) bytes[8 + index] = index + 1;
  return bytes;
}

function stdoutSpy(isTTY = true): { readonly writes: string[]; readonly stdout: { write(chunk: string): boolean; readonly isTTY: boolean } } {
  const writes: string[] = [];
  return {
    writes,
    stdout: {
      write(chunk: string): boolean {
        writes.push(chunk);
        return true;
      },
      isTTY,
    },
  };
}

const enoent = (): Error => Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
const timedOut = (): Error => Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' });

const linux = (env: NodeJS.ProcessEnv, procVersion = ''): ClipboardDeps => ({ platform: 'linux', env, procVersion });
const wayland: ClipboardDeps = linux({ WAYLAND_DISPLAY: 'wayland-0' });
const x11: ClipboardDeps = linux({ DISPLAY: ':0' });
const macos: ClipboardDeps = { platform: 'darwin', env: {} };
const windows: ClipboardDeps = { platform: 'win32', env: {} };

const always = async (): Promise<boolean> => true;
const never = async (): Promise<boolean> => false;

describe('clipboardBackend', () => {
  it('picks the tool family by where the clipboard is, not by the kernel', () => {
    expect(clipboardBackend(macos)).toBe('macos');
    expect(clipboardBackend(windows)).toBe('windows');
    expect(clipboardBackend(linux({ WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }))).toBe('wayland');
    expect(clipboardBackend(linux({ DISPLAY: ':0' }))).toBe('x11');
    expect(clipboardBackend({ platform: 'freebsd', env: { DISPLAY: ':0' } })).toBe('none');
  });

  it('treats WSL as Windows, by the distribution name or by the kernel version', () => {
    expect(clipboardBackend(linux({ WSL_DISTRO_NAME: 'Ubuntu', DISPLAY: ':0' }))).toBe('windows');
    expect(clipboardBackend(linux({ DISPLAY: ':0' }, 'Linux version 5.15.0-microsoft-standard-WSL2'))).toBe('windows');
  });

  it('has no backend in a session with no display, so a copy goes straight to the terminal', () => {
    expect(clipboardBackend(linux({}))).toBe('none');
  });
});

describe('readClipboardImage', () => {
  it('runs pngpaste on macOS when it is installed', async () => {
    const exec = answering(pngBytes(4));
    const image = await readClipboardImage({ ...macos, execFile: exec.execFile, which: always });

    expect(exec.calls).toEqual([{ file: 'pngpaste', args: ['-'], options: READ_OPTIONS }]);
    expect(image).toEqual({ bytes: pngBytes(4), mediaType: 'image/png' });
  });

  it('falls back to AppleScript writing a temp file, and leaves nothing behind', async () => {
    let target: string | undefined;
    const exec = fakeExec(async ({ args }) => {
      target = /"(.+)"/.exec(args[1] ?? '')?.[1];
      await writeFile(target ?? '', pngBytes(3));
      return new Uint8Array();
    });

    const image = await readClipboardImage({ ...macos, execFile: exec.execFile, which: never });

    const call = exec.calls[0];
    expect(call?.file).toBe('osascript');
    expect(call?.args.filter((argument) => argument === '-e')).toHaveLength(3);
    expect(call?.args[3]).toBe('write (the clipboard as «class PNGf») to target');
    expect(target?.endsWith('clipboard.png')).toBe(true);
    expect(image?.bytes).toEqual(pngBytes(3));
    await expect(access(target ?? '')).rejects.toThrow();
  });

  it('asks wl-paste for a PNG under Wayland', async () => {
    const exec = answering(pngBytes(1));
    const image = await readClipboardImage({ ...wayland, execFile: exec.execFile, which: always });

    expect(exec.calls).toEqual([{ file: 'wl-paste', args: ['-t', 'image/png'], options: READ_OPTIONS }]);
    expect(image?.mediaType).toBe('image/png');
  });

  it('asks xclip for the clipboard selection under X11', async () => {
    const exec = answering(pngBytes(1));
    await readClipboardImage({ ...x11, execFile: exec.execFile, which: always });

    expect(exec.calls).toEqual([{ file: 'xclip', args: ['-selection', 'clipboard', '-t', 'image/png', '-o'], options: READ_OPTIONS }]);
  });

  it('decodes base64 from one powershell command on Windows and inside WSL', async () => {
    const encoded = Buffer.from(pngBytes(6)).toString('base64');
    for (const deps of [windows, linux({ WSL_DISTRO_NAME: 'Ubuntu' })]) {
      const exec = answering(`${encoded}\n`);
      const image = await readClipboardImage({ ...deps, execFile: exec.execFile, which: always });

      const call = exec.calls[0];
      expect(call?.file).toBe('powershell.exe');
      expect(call?.args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
      expect(call?.args[3]).toContain('Get-Clipboard -Format Image');
      expect(call?.options.timeoutMs).toBe(CLIPBOARD_TIMEOUT_MS);
      expect(image?.bytes).toEqual(pngBytes(6));
    }
  });

  it('is null for a missing tool, an empty clipboard, a timeout, and a clipboard holding text', async () => {
    const missing = answering(enoent());
    expect(await readClipboardImage({ ...wayland, execFile: missing.execFile, which: never })).toBeNull();

    const empty = answering(new Uint8Array());
    expect(await readClipboardImage({ ...wayland, execFile: empty.execFile, which: always })).toBeNull();

    const slow = answering(timedOut());
    expect(await readClipboardImage({ ...x11, execFile: slow.execFile, which: always })).toBeNull();

    // xclip can exit zero having printed a complaint; the signature is what
    // separates an image from an apology.
    const text = answering('Error: target image/png not available');
    expect(await readClipboardImage({ ...x11, execFile: text.execFile, which: always })).toBeNull();
  });

  it('runs nothing at all when the session has no clipboard', async () => {
    const exec = answering(pngBytes(1));
    expect(await readClipboardImage({ ...linux({}), execFile: exec.execFile, which: always })).toBeNull();
    expect(exec.calls).toEqual([]);
  });

  it('refuses an image past the attachment cap and accepts one exactly at it', async () => {
    const oversized = pngBytes(MAX_ATTACHMENT_BYTES + 1 - 8);
    const over = answering(oversized);
    expect(await readClipboardImage({ ...wayland, execFile: over.execFile, which: always })).toBeNull();

    const at = answering(oversized.subarray(0, MAX_ATTACHMENT_BYTES));
    const image = await readClipboardImage({ ...wayland, execFile: at.execFile, which: always });
    expect(image?.bytes.length).toBe(MAX_ATTACHMENT_BYTES);
  });
});

describe('readClipboardText', () => {
  it('runs the text tool for each backend', async () => {
    const cases: readonly (readonly [ClipboardDeps, string, readonly string[]])[] = [
      [macos, 'pbpaste', []],
      [wayland, 'wl-paste', ['-n']],
      [x11, 'xclip', ['-selection', 'clipboard', '-o']],
    ];
    for (const [deps, file, args] of cases) {
      const exec = answering('hello');
      expect(await readClipboardText({ ...deps, execFile: exec.execFile, which: always })).toBe('hello');
      expect(exec.calls).toEqual([{ file, args, options: READ_OPTIONS }]);
    }
  });

  it('asks powershell for the raw clipboard, in UTF-8, without a trailing newline', async () => {
    const exec = answering('héllo — there');
    const text = await readClipboardText({ ...windows, execFile: exec.execFile, which: always });

    const script = exec.calls[0]?.args[3] ?? '';
    expect(script).toContain('Get-Clipboard -Raw');
    expect(script).toContain('[Console]::OutputEncoding');
    expect(script).toContain('[Console]::Out.Write($text)');
    expect(text).toBe('héllo — there');
  });

  it('keeps the line endings it was given: the buffer decides what to do with them', async () => {
    const exec = answering('one\r\ntwo\r\n');
    expect(await readClipboardText({ ...windows, execFile: exec.execFile, which: always })).toBe('one\r\ntwo\r\n');
  });

  it('is null for an empty clipboard, a missing tool, and no backend', async () => {
    expect(await readClipboardText({ ...x11, execFile: answering('').execFile, which: always })).toBeNull();
    expect(await readClipboardText({ ...x11, execFile: answering(enoent()).execFile, which: never })).toBeNull();
    expect(await readClipboardText({ ...linux({}), execFile: answering('hi').execFile, which: always })).toBeNull();
  });

  it('refuses text past the attachment cap', async () => {
    const huge = new Uint8Array(MAX_ATTACHMENT_BYTES + 1).fill(0x61);
    expect(await readClipboardText({ ...wayland, execFile: answering(huge).execFile, which: always })).toBeNull();
  });
});

describe('osc52Sequence', () => {
  it('is the copy sequence and nothing else, base64 of the UTF-8 bytes', () => {
    expect(osc52Sequence('hi')).toBe(`${ESC}]52;c;aGk=${BEL}`);
    expect(osc52Sequence('née 🎉')).toBe(`${ESC}]52;c;${Buffer.from('née 🎉', 'utf8').toString('base64')}${BEL}`);
  });

  it('doubles every escape inside a tmux passthrough', () => {
    expect(osc52Sequence('hi', { tmux: true })).toBe(`${ESC}Ptmux;${ESC}${ESC}]52;c;aGk=${BEL}${ESC}\\`);
  });
});

describe('copyText', () => {
  it('uses the native tool for each backend, with the text on stdin', async () => {
    const cases: readonly (readonly [ClipboardDeps, string, readonly string[]])[] = [
      [macos, 'pbcopy', []],
      [wayland, 'wl-copy', []],
      [x11, 'xclip', ['-selection', 'clipboard']],
      [windows, 'clip.exe', []],
    ];
    for (const [deps, file, args] of cases) {
      const exec = answering(new Uint8Array());
      const spy = stdoutSpy();
      expect(await copyText('a draft', { ...deps, execFile: exec.execFile, which: always, stdout: spy.stdout })).toBe('native');
      expect(exec.calls).toEqual([{ file, args, options: { input: 'a draft', timeoutMs: CLIPBOARD_TIMEOUT_MS } }]);
      expect(spy.writes).toEqual([]);
    }
  });

  it('writes OSC 52 when no native tool is installed', async () => {
    const exec = answering(new Uint8Array());
    const spy = stdoutSpy();

    expect(await copyText('hi', { ...x11, execFile: exec.execFile, which: never, stdout: spy.stdout })).toBe('osc52');
    expect(exec.calls).toEqual([]);
    expect(spy.writes).toEqual([`${ESC}]52;c;aGk=${BEL}`]);
  });

  it('wraps the sequence for tmux', async () => {
    const spy = stdoutSpy();
    await copyText('hi', { ...linux({ DISPLAY: ':0', TMUX: '/tmp/tmux-1000/default,123,0' }), execFile: answering(new Uint8Array()).execFile, which: never, stdout: spy.stdout });

    expect(spy.writes).toEqual([`${ESC}Ptmux;${ESC}${ESC}]52;c;aGk=${BEL}${ESC}\\`]);
  });

  it('prefers OSC 52 over SSH even when a native tool is installed, because that clipboard is the wrong machine’s', async () => {
    const exec = answering(new Uint8Array());
    const spy = stdoutSpy();

    const outcome = await copyText('hi', { platform: 'darwin', env: { SSH_TTY: '/dev/pts/3' }, execFile: exec.execFile, which: always, stdout: spy.stdout });

    expect(outcome).toBe('osc52');
    expect(exec.calls).toEqual([]);
    expect(spy.writes).toHaveLength(1);
  });

  it('still reaches the remote clipboard over SSH when there is no terminal to write to', async () => {
    const exec = answering(new Uint8Array());
    const spy = stdoutSpy(false);

    const outcome = await copyText('hi', { platform: 'darwin', env: { SSH_TTY: '/dev/pts/3' }, execFile: exec.execFile, which: always, stdout: spy.stdout });

    expect(outcome).toBe('native');
    expect(exec.calls[0]?.file).toBe('pbcopy');
    expect(spy.writes).toEqual([]);
  });

  it('falls through to OSC 52 when the native tool fails or hangs', async () => {
    const exec = answering(timedOut());
    const spy = stdoutSpy();

    expect(await copyText('hi', { ...x11, execFile: exec.execFile, which: always, stdout: spy.stdout })).toBe('osc52');
    expect(exec.calls).toHaveLength(1);
    expect(spy.writes).toHaveLength(1);
  });

  it('is none with no tool and no terminal, and none for empty text', async () => {
    const exec = answering(new Uint8Array());
    const dark = stdoutSpy(false);
    expect(await copyText('hi', { ...x11, execFile: exec.execFile, which: never, stdout: dark.stdout })).toBe('none');

    const spy = stdoutSpy();
    expect(await copyText('', { ...macos, execFile: exec.execFile, which: always, stdout: spy.stdout })).toBe('none');
    expect(exec.calls).toEqual([]);
    expect(spy.writes).toEqual([]);
  });

  it('never writes to a stream that is not a terminal', async () => {
    const spy = stdoutSpy(false);
    expect(await copyText('hi', { ...linux({}), execFile: answering(new Uint8Array()).execFile, which: never, stdout: spy.stdout })).toBe('none');
    expect(spy.writes).toEqual([]);
  });
});

describe('onPath', () => {
  it.skipIf(process.platform === 'win32')('finds an executable on PATH and ignores one without the bit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'artemis-path-'));
    await writeFile(join(directory, 'wl-copy'), '#!/bin/sh\n');
    await chmod(join(directory, 'wl-copy'), 0o755);
    await writeFile(join(directory, 'notes'), 'not a program');
    const env: NodeJS.ProcessEnv = { PATH: ['', join(directory, 'missing'), directory].join(delimiter) };

    expect(await onPath('wl-copy', env, 'linux')).toBe(true);
    expect(await onPath('notes', env, 'linux')).toBe(false);
    expect(await onPath('pngpaste', env, 'linux')).toBe(false);
  });

  it('resolves a Windows command through PATHEXT, and an explicit extension as it is', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'artemis-path-'));
    await writeFile(join(directory, 'clip.exe'), 'MZ');
    await writeFile(join(directory, 'tool.CMD'), 'rem');
    const env: NodeJS.ProcessEnv = { PATH: directory, PATHEXT: '.COM;.EXE;.CMD' };

    expect(await onPath('clip.exe', env, 'win32')).toBe(true);
    expect(await onPath('tool', env, 'win32')).toBe(true);
    expect(await onPath('missing', env, 'win32')).toBe(false);
  });

  it('is false when PATH is empty rather than looking in the working directory', async () => {
    expect(await onPath('wl-copy', {}, 'linux')).toBe(false);
  });
});

describe('runClipboardTool', () => {
  it('feeds a real program its stdin and hands back the bytes it wrote', async () => {
    // The only test that starts a process. It proves the wiring the injected
    // runner stands in for everywhere else: buffer encoding, and a standard
    // input that is closed rather than left open.
    const directory = await mkdtemp(join(tmpdir(), 'artemis-clip-run-'));
    const file = join(directory, 'note.txt');
    const source = [
      "const fs = require('fs');",
      `fs.writeFileSync(${JSON.stringify(file)}, fs.readFileSync(0));`,
      "process.stdout.write(Buffer.from([0x89, 0x50]));",
    ].join(' ');

    const { stdout } = await runClipboardTool(process.execPath, ['-e', source], { input: 'piped text' });

    expect(await readFile(file, 'utf8')).toBe('piped text');
    expect(new Uint8Array(stdout)).toEqual(Uint8Array.of(0x89, 0x50));
  });

  it('rejects for a non-zero exit and for a program that is not there', async () => {
    await expect(runClipboardTool(process.execPath, ['-e', 'process.exit(1)'], {})).rejects.toThrow();
    await expect(runClipboardTool('artemis-no-such-tool', [], {})).rejects.toThrow();
  });
});
